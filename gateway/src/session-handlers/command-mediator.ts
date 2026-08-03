// The command choke point (session-model spec §3.7, §3.6, §8.3) — ONE place
// where an inbound command becomes an action on a session.
//
// WHY IT EXISTS AT ALL. `text.input`, `interrupt` and the permission answer
// carried no session identity: the gateway applied each to whatever session the
// socket happened to be on when the bytes landed. That was not a latent bug
// under one connection per session, because the two could not disagree. The
// moment a connection can SWITCH sessions — the feature this whole redesign
// exists to deliver — a command typed into session A and a
// `conversation.activate` onto session B are two frames in flight at once, and
// the loser lands in the wrong conversation. §3.7 files this as a correctness
// condition, not a risk.
//
// ONE GATE, MIRRORING `ToolBroker`'s DISCIPLINE. Every acting command goes
// through `mediateCommand` and nothing re-implements a piece of it in a switch
// arm. Verb-style checks sprinkled across ws-handlers.ts is precisely how a
// bypass appears later — the shape "barge-in goes straight to the runtime
// because it is only a cancel" is one refactor away from being the hole.
//
// WHAT IT DOES *NOT* GATE, deliberately:
//
//   - `session.configure`, `session.new`, `conversation.activate`. These are how
//     a connection LEAVES or CHANGES its session; binding them to the session
//     they are leaving would make switching unreachable.
//   - `ping` and `user.preferences.patch`. Neither acts on a session — one is
//     transport liveness, the other writes a user profile.
//   - INBOUND BINARY AUDIO. The connection's attachment is authoritative for
//     mic bytes — the deliberate decision §3.7 step 9 asks for rather than an
//     omission. The reasoning, and the control that makes it sound, are stated
//     under "WHY BINARY AUDIO IS NOT STAMPED" below.
//
// TWO PHASES, AND THE SPLIT IS LOAD-BEARING. `mediateCommand` (credential, then
// binding) runs BEFORE the runtime is resolved, because on a draft that
// resolution MINTS a session and a stale-generation command must never mint one.
// `claimInputFloor` (arbitration) runs AFTER it, because a floor claim is made
// on behalf of an input that is actually going to be submitted — claiming first
// burns the floor for a message that ended in `orchestrator_unavailable` and
// refuses a peer for a dispatch that did nothing. Both phases live here; the
// switch arms hold no logic of their own.
//
// ORDER WITHIN PHASE ONE IS ALSO THE CONTRACT: credential, then binding. A
// window whose token expired must not be able to act on its way out.

import type { CommandRefusal, CommandRejectedMessage } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import { detachSession } from "./session-binding.js";
import type { Attachment, SessionRegistry } from "./session-registry.js";
import type { SessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "command-mediator"]);

/** RFC 6455 policy violation — the same code the auth gate closes on. */
const WS_CLOSE_POLICY = 1008;

/**
 * What the mediator can be asked about.
 *
 * `"transcript"` has no frame of its own: a spoken input reaches the gateway as
 * mic bytes and becomes a command only when STT finalizes an utterance
 * (stt-session.ts). It is mediated at that point — which is later, and
 * therefore MORE accurate, than a stamp captured at frame-encode time would
 * have been.
 */
export type CommandKind =
  | "text.input"
  | "transcript"
  | "interrupt"
  | "permission.response"
  | "audio.start"
  | "audio.end";

export interface InboundCommand {
  readonly type: CommandKind;
  /** The session the CLIENT believed it was in. Absent on a spoken input and on
   *  an unstamped client's frame. */
  readonly sessionId?: string | undefined;
  /** The generation of the attachment the client believed it held. */
  readonly generation?: number | undefined;
  /** Echoed back on a refusal so the client can settle the exact bubble. */
  readonly pendingId?: string | undefined;
}

/**
 * ACCEPT CARRIES NULLS, and that is not laxity.
 *
 * A DRAFT connection has no session and no attachment (spec §4.2) yet its
 * `text.input` is the very frame that mints one. `{sessionId: null,
 * attachmentId: null}` is the honest description of that state; the alternative
 * — refusing every unbound command — would make it impossible to start a
 * conversation at all.
 */
export type CommandVerdict =
  | { accept: true; sessionId: string | null; attachmentId: string | null }
  | { accept: false; reason: CommandRefusal };

/**
 * Commands that cannot mean anything without a session.
 *
 * Only the permission answer. Everything else is reachable on a DRAFT and must
 * stay reachable: `text.input` mints the session, `audio.start` / `audio.end` /
 * `"transcript"` are the voice-first path to the same mint, and `interrupt` on a
 * draft has always been an idempotent no-op.
 */
const REQUIRES_ATTACHMENT: ReadonlySet<CommandKind> = new Set<CommandKind>(["permission.response"]);

/**
 * Refusals that mean "your audio is aimed at a conversation you are not in any
 * more", and therefore must not be allowed to finalize into it.
 *
 * `session_busy` is pointedly absent: losing a race means somebody beat this
 * window to one dispatch, not that its uplink belongs elsewhere. Cutting the
 * mic there would truncate the next thing the person says.
 */
const DISCARDS_STT: ReadonlySet<CommandRefusal> = new Set<CommandRefusal>(["stale_generation", "credential_expired"]);

// WHY BINARY AUDIO IS NOT STAMPED — the deliberate decision §3.7 step 9 asks
// for, stated once, here.
//
// Inbound mic frames carry NO header at all: the whole WS binary payload is
// opus/pcm bytes handed straight to the STT adapter (`SttSession.pushFrame`).
// The fixed-width header in shared/protocol's layout comment is the OUTBOUND
// one. Adding an inbound binding header would mean changing every client's
// uplink encoder and the STT wire in the same breath, for a stamp captured tens
// of milliseconds before the session it names could possibly change.
//
// THE HAZARD, AND WHERE IT IS ACTUALLY CLOSED. Bytes captured before a switch
// must not be transcribed into the session after it. That is closed by
// `detachSession` (session-binding.ts) discarding the uplink on EVERY leave —
// not by anything in this file, and the distinction matters enough to state
// plainly here, because the obvious-looking answer is wrong:
//
//   A drawer switch sends `conversation.activate`, which is deliberately
//   UNSTAMPED — it is how a connection leaves — so no command is ever refused
//   and this mediator never sees the switch at all. `DISCARDS_STT` below covers
//   only the case where a client sends a STALE-stamped command afterwards, and
//   the transcript path in particular can never reach it: `ws-handlers.ts`
//   mediates a transcript with an EMPTY binding by construction, so
//   `claimsSession` is false and `stale_generation` is unreachable for spoken
//   input. The leave path is the only place that can be the control, so that is
//   where the control lives.
//
// What remains true here: mic bytes are not a command; they become one at the
// TRANSCRIPT, which IS mediated (`"transcript"` above) against the attachment as
// it stands then. That is the right place to check WHETHER the speaker may
// submit. It is not, and cannot be, the place that notices they walked out of
// the room mid-sentence.

/**
 * [attachment] is passed rather than read off the socket because the
 * `credential_expired` path DETACHES before it refuses: reading here would log
 * `sessionId: null, attachmentId: null` for exactly the refusal whose whole
 * point is naming the window that was cut off.
 */
function reject(
  cmd: InboundCommand,
  conn: ServerWebSocket<SessionData>,
  reason: CommandRefusal,
  detail: string,
  attachment: Attachment | null = conn.data.attachment,
): CommandVerdict {
  log.warn("command.refused", {
    connectionId: conn.data.sessionId,
    sessionId: attachment?.sessionId ?? null,
    attachmentId: attachment?.attachmentId ?? null,
    generation: attachment?.generation ?? null,
    command: cmd.type,
    claimedSessionId: cmd.sessionId ?? null,
    claimedGeneration: cmd.generation ?? null,
    // TWO FIELDS, NOT ONE INTERPOLATED STRING. `reason` is the machine token a
    // log query filters on; folding the prose into it makes
    // `reason="session_busy"` match nothing.
    reason,
    detail,
  });

  if (DISCARDS_STT.has(reason)) discardUplink(conn, reason);

  // SAY NO OUT LOUD. Silence is indistinguishable from a lost network and
  // leaves an optimistic bubble unreconciled and a Stop button spinning
  // forever.
  const frame: CommandRejectedMessage = {
    type: "command.rejected",
    command: cmd.type,
    reason,
    ...(cmd.pendingId === undefined ? {} : { pendingId: cmd.pendingId }),
  };
  sendConnectionFrame(conn, frame);
  return { accept: false, reason };
}

/**
 * Drop whatever this connection's mic has buffered, WITHOUT finalizing it.
 *
 * `SttSession.end()` is the wrong tool and the reason is the whole point of the
 * distinction: it force-flushes, so the half-sentence already captured would be
 * transcribed and submitted — into the session the connection is on NOW.
 * Committing half an utterance into the wrong conversation is worse than
 * dropping it.
 */
function discardUplink(conn: ServerWebSocket<SessionData>, reason: CommandRefusal): void {
  const stt = conn.data.stt;
  if (stt === null) return;
  log.info("command.stt-discarded", {
    connectionId: conn.data.sessionId,
    bufferedBytes: stt.buffered,
    reason: `${reason}: this connection's mic is aimed at a session it is no longer a window on`,
  });
  stt.discard();
}

/**
 * Decide whether [cmd] may act, and on what — credential, then binding.
 *
 * ARBITRATION IS NOT HERE; it is `claimInputFloor` below, called by the input
 * call sites AFTER they have a runtime. See that function for why the gate is
 * two-phase.
 *
 * [nowMs] is injectable so the expiry check is deterministic under test;
 * production always takes the default. It is NOT read from the client — a clock
 * the caller supplies would be an input to a security decision.
 */
export function mediateCommand(
  cmd: InboundCommand,
  conn: ServerWebSocket<SessionData>,
  registry: SessionRegistry,
  nowMs: number = Date.now(),
): CommandVerdict {
  // ── 1. Credential (§3.6) ──
  //
  // `UserPrincipal` is frozen and carries no expiry, and the PASETO token is
  // validated ONCE at connect — so without this an attachment outlives its
  // credential indefinitely and a token that expired hours ago keeps
  // authorizing. Revalidated here, at the same choke point, and failing closed.
  const expiresAtMs = conn.data.tokenExpiresAtMs;
  if (expiresAtMs !== null && nowMs >= expiresAtMs) {
    // CLOSE THE SOCKET — detaching alone is not failing closed.
    //
    // Detaching stops the fan-out reaching this window, which is §3.6's "this
    // covers reads too". But `session.configure`, `session.new` and
    // `conversation.activate` are deliberately OUTSIDE this gate — they are how
    // a connection changes session, so binding them to the session being left
    // would make switching unreachable — and none of them checks expiry. So a
    // detached connection re-attaches by sending any one of them and resumes
    // reading every fanned-out frame, indefinitely, on a credential that
    // expired hours ago. The detach would be undone by the next frame.
    //
    // A CLOSED SOCKET collapses that: it cannot read, cannot re-attach, and has
    // to come back through the auth gate with a fresh expiry. The detach still
    // runs first so the subscriber set is correct even if the close races.
    //
    // `code: "expired"` is `token-service.ts`'s own vocabulary for this, which
    // is what mobile's `AuthErrorClass` already classifies as terminal (→ route
    // to login) and what web converges on when its reconnect re-presents the
    // dead token during `authenticating`.
    const expired = conn.data.attachment;
    detachSession(conn, { sessionRegistry: registry });
    const verdict = reject(
      cmd,
      conn,
      "credential_expired",
      "this connection's token expired — attachment dropped and socket closing",
      expired,
    );
    sendConnectionFrame(conn, {
      type: "auth.error",
      code: "expired",
      message: "session token expired — please sign in again",
    });
    conn.close(WS_CLOSE_POLICY, "credential expired");
    return verdict;
  }

  // ── 2. Binding (§3.7) ──
  const attachment = conn.data.attachment;
  const claimsSession = cmd.sessionId !== undefined || cmd.generation !== undefined;

  if (claimsSession) {
    // BOTH HALVES OR NEITHER. `generation` restarts at 1 per session, so it is
    // meaningless alone; `sessionId` alone cannot tell a command issued before
    // a re-attach from one issued after it (a reload re-`session.configure`s
    // onto the SAME session and gets a fresh generation). A frame carrying one
    // is a client bug, and letting it through would silently degrade the check
    // to whichever half arrived.
    if (attachment === null || cmd.sessionId !== attachment.sessionId || cmd.generation !== attachment.generation) {
      return reject(
        cmd,
        conn,
        "stale_generation",
        "the command named a session/generation this connection is not currently a window on",
      );
    }
  } else if (attachment === null && REQUIRES_ATTACHMENT.has(cmd.type)) {
    return reject(cmd, conn, "not_attached", "this command needs a session and this connection is in none");
  }

  log.debug("command.accepted", {
    connectionId: conn.data.sessionId,
    sessionId: attachment?.sessionId ?? null,
    attachmentId: attachment?.attachmentId ?? null,
    generation: attachment?.generation ?? null,
    command: cmd.type,
    bound: claimsSession,
  });
  return { accept: true, sessionId: attachment?.sessionId ?? null, attachmentId: attachment?.attachmentId ?? null };
}

/**
 * PHASE TWO of the gate: take this session's input floor, or refuse
 * `session_busy` (§8.3).
 *
 * WHY IT IS A SEPARATE PHASE, and why that is not the "sprinkled verb checks"
 * this module exists to prevent. Both phases live in this one module and every
 * input passes through both; what differs is WHEN. Phases 1 and 2 of
 * `mediateCommand` must run BEFORE `ensureBoundRuntime`, because on a draft that
 * call MINTS a session and a stale-generation command must never mint one. The
 * floor must be claimed AFTER it, because a claim is a claim on behalf of an
 * input that is actually going to be submitted — and `ensureBoundRuntime` can
 * still fail (`orchestrator_unavailable`, no active LLM key). Claiming first
 * burns the floor for a message that went nowhere and refuses a peer for a
 * dispatch that did nothing.
 *
 * ONLY `text.input` AND `transcript` REACH HERE (§8.3: "every input form: mic
 * onset, text, or anything later"). `audio.start` arms the mic and says nothing
 * yet — two windows may both hold an open mic, and refusing the second would
 * break hold-to-talk everywhere but one. `interrupt` is §8.3 in its own words:
 * "barge-in from any window is honoured whenever it lands" — arbitrating Stop
 * would let one window's typing lock out the only person watching a runaway
 * reply.
 */
export function claimInputFloor(
  cmd: InboundCommand,
  conn: ServerWebSocket<SessionData>,
  registry: SessionRegistry,
  nowMs: number = Date.now(),
): boolean {
  const attachment = conn.data.attachment;
  // A DRAFT has no session and therefore no floor to contend for. It is also
  // the one place contention cannot matter: the mint is idempotent under the
  // draft key, so two connections on one draft resolve to one session.
  if (attachment === null) return true;
  const arbiter = registry.handlesFor(attachment.sessionId)?.arbiter ?? null;
  if (arbiter === null) return true;
  if (arbiter.claim(attachment.attachmentId, nowMs)) return true;
  reject(cmd, conn, "session_busy", "another window claimed this session's input floor at this dispatch");
  return false;
}
