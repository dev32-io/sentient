// The frameType → lane table (session-model spec §2.1) — TOTAL over the wire
// union, and a contract break when it is not.
//
// TWO LANES, NOT ONE. A session owns a monotonic seq space carrying the frames
// that belong to the CONVERSATION; a connection owns the frames that belong to
// the SOCKET. The first draft of this design gave every outbound frame one seq
// space, which leaks one window's private frames — its auth result, its resume
// coordination, its session-ready — into every other window attached to the
// same session.
//
//   | Lane       | Owner       | Journaled | Delivery                        |
//   |------------|-------------|-----------|---------------------------------|
//   | session    | the session | yes       | every attached window           |
//   | connection | the socket  | NEVER     | exactly the socket it answers   |
//
// WHY THIS IS DERIVED FROM THE UNION AND NOT HAND-LISTED. `FRAME_LANES` is
// typed `Record<GatewayMessage["type"], FrameLane>`, so a frame added to
// `gatewayMessageSchema` with no lane fails TYPECHECK — the table cannot rot
// silently. `ALL_GATEWAY_MESSAGE_TYPES` reads the same union back out of zod at
// runtime, which is what lets a test prove totality against the contract rather
// than against a second hand-written list that would rot in the same way.
//
// AN UNASSIGNED TYPE THROWS. It does not default. A default would silently pick
// a side for a frame nobody classified, and the two wrong answers are "leak a
// private frame to every window" and "drop conversation content out of the
// replay window" — neither is a safe fallback, so the only correct behaviour is
// to refuse. Unreachable while the `Record` type holds; reachable only from a
// value that entered the process as `unknown` and was cast.

import { type GatewayMessage, gatewayMessageSchema } from "@sentient/protocol";

export type FrameLane = "session" | "connection";

/** Shape of a zod discriminated-union member, narrowed to the one field this
 *  module reads. Declared locally because `shared/protocol` is frozen for this
 *  wave and exports no type-list of its own. */
interface DiscriminatedOption {
  readonly shape: { readonly type: { readonly value: GatewayMessage["type"] } };
}

/**
 * Every `type` in `gatewayMessageSchema`, read back out of the zod union.
 *
 * The point is that this list is NOT maintained by hand: it is whatever the
 * frozen wire contract currently says, so a test asserting `frameLane` accepts
 * all of it is a test against the contract.
 */
export const ALL_GATEWAY_MESSAGE_TYPES: readonly GatewayMessage["type"][] = (
  gatewayMessageSchema.options as unknown as readonly DiscriminatedOption[]
).map((option) => option.shape.type.value);

/**
 * Lane per frame type.
 *
 * SESSION lane — the conversation. Turn lifecycle, text deltas, tool tiles,
 * permission mediation, delegation progress, committed feed ENTRIES, audio
 * bracketing and title updates. Allocated once from the session journal and
 * written to every attached window.
 *
 * CONNECTION lane — this socket's own business. Auth results, the ready
 * handshake, pong, resume coordination, the sessions-list acks, and errors.
 * Never journaled and never fanned out.
 *
 * `conversation.snapshot` is CONNECTION lane, which is the least obvious entry
 * here and the most load-bearing. It carries conversation content, but it is an
 * ANSWER to the connection that just attached, not an event in the
 * conversation: both SDKs REPLACE their committed mirror on it, so fanning it
 * out overwrites a peer's mirror mid-turn, and journaling it would replay one
 * window's attach answer into another window's reconnect. `conversation.entry`
 * — the incremental commit — is the session-lane frame that carries the same
 * content forward.
 */
const FRAME_LANES: Record<GatewayMessage["type"], FrameLane> = {
  // ─── connection lane ───
  "auth.ok": "connection",
  "auth.error": "connection",
  "session.ready": "connection",
  "session.expired": "connection",
  "stream.resumed": "connection",
  pong: "connection",
  error: "connection",
  "sessions.error": "connection",
  "session.created": "connection",
  "session.draft": "connection",
  "session.switched": "connection",
  // The sessions LIST is user-scoped, not session-scoped: these answer the
  // connection that issued the delete/rename. Neither has an emitter yet; a
  // later wave that wants every window of a user to see them needs a user
  // lane, which this spec deliberately does not have — it must not smuggle
  // them onto a session's journal, where they would replay into an unrelated
  // conversation's resume.
  "sessions.deleted": "connection",
  "sessions.renamed": "connection",
  // See the doc above — the attach answer, not conversation content.
  "conversation.snapshot": "connection",

  // ─── session lane ───
  "turn.started": "session",
  "turn.text.delta": "session",
  "turn.completed": "session",
  "turn.aborted": "session",
  "turn.tool.update": "session",
  "turn.audio.start": "session",
  "turn.audio.done": "session",
  "playback.stop": "session",
  "permission.request": "session",
  "permission.resolved": "session",
  "delegation.progress": "session",
  "conversation.entry": "session",
  // Titling (spec §6) lands as a session-lane frame so every attached window
  // renames live. Task 10 wires its emitter.
  "session.title": "session",
};

/**
 * Which lane [type] travels on.
 *
 * @throws when the type has no lane — a contract break, not a default. See
 *         this file's header.
 */
export function frameLane(type: GatewayMessage["type"]): FrameLane {
  const lane = FRAME_LANES[type];
  if (lane === undefined) {
    throw new Error(
      `frame type "${type}" has no lane assignment — add it to FRAME_LANES (session-handlers/frame-lanes.ts)`,
    );
  }
  return lane;
}
