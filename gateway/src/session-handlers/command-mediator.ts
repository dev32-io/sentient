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
//     mic bytes; see `audioBindsToTheConnection` below for the reasoning, which
//     is the deliberate decision §3.7 asks for rather than an omission.
//
// ORDER IS PART OF THE CONTRACT: credential, then binding, then arbitration. A
// window whose token expired must not win an input race on its way out, and a
// command aimed at a session this connection has left must not consume that
// session's input floor.

import type { CommandRefusal, CommandRejectedMessage } from "@sentient/protocol";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging/logger.js";
import { detachSession } from "./session-binding.js";
import type { SessionRegistry } from "./session-registry.js";
import type { SessionData } from "./ws-helpers.js";
import { sendConnectionFrame } from "./ws-send.js";

const log = getLog(["sentient", "ws", "command-mediator"]);

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
 * Commands that count as INPUT for arbitration (§8.3: "this applies to every
 * input form: mic onset, text, or anything later").
 *
 * `audio.start` is NOT one. It arms the mic; it says nothing yet. Two windows
 * may both hold an open mic — refusing the second would break hold-to-talk in
 * every window but one. The contention §8.3 describes happens when a person
 * actually says something, which is `"transcript"`.
 *
 * `interrupt` is NOT one either, and that is §8.3 in its own words: "barge-in
 * from any window is honoured whenever it lands." Arbitrating Stop would let
 * one window's input lock out the only person watching a runaway reply.
 */
const INPUT_COMMANDS: ReadonlySet<CommandKind> = new Set<CommandKind>(["text.input", "transcript"]);

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
// And it would buy nothing, because mic bytes are not a command. They become
// one at the TRANSCRIPT, which IS mediated (`"transcript"` above) against the
// connection's attachment as it stands at that moment — later, and therefore
// more accurate, than any stamp. The hazard a stamp would close — "audio
// captured before a switch is transcribed into the session after it" — is
// closed instead by DISCARDING the uplink on a stale refusal (`DISCARDS_STT`),
// which is strictly stronger: the bytes are dropped rather than allowed to
// finalize anywhere.

function reject(
  cmd: InboundCommand,
  conn: ServerWebSocket<SessionData>,
  reason: CommandRefusal,
  detail: string,
): CommandVerdict {
  const attachment = conn.data.attachment;
  log.warn("command.refused", {
    connectionId: conn.data.sessionId,
    sessionId: attachment?.sessionId ?? null,
    attachmentId: attachment?.attachmentId ?? null,
    generation: attachment?.generation ?? null,
    command: cmd.type,
    claimedSessionId: cmd.sessionId ?? null,
    claimedGeneration: cmd.generation ?? null,
    reason: `${reason}: ${detail}`,
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
 * Decide whether [cmd] may act, and on what.
 *
 * [nowMs] is injectable so arbitration is deterministic under test; production
 * always takes the default. It is NOT read from the client — a clock the caller
 * supplies would be an input to a security decision.
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
    // DETACH, not merely refuse. §3.6 covers reads: a revoked principal that
    // stays in the subscriber set keeps receiving every frame the session fans
    // out. Dropping the attachment is what stops that, and it is done BEFORE
    // the refusal is logged so the log line already reflects the new state.
    detachSession(conn, { sessionRegistry: registry });
    return reject(cmd, conn, "credential_expired", "this connection's token expired — attachment dropped");
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

  // ── 3. Arbitration (§8.3) ──
  if (attachment !== null && INPUT_COMMANDS.has(cmd.type)) {
    const arbiter = registry.handlesFor(attachment.sessionId)?.arbiter ?? null;
    if (arbiter !== null && !arbiter.claim(attachment.attachmentId, nowMs)) {
      return reject(cmd, conn, "session_busy", "another window won this dispatch");
    }
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
