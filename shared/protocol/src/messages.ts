/**
 * Binary frame layout (audio frames sent gateway → client):
 *
 *   ┌──────────────────────────────┬────────────┬──────────────────────┐
 *   │  8 bytes (big-endian u64)    │  1 byte    │  N bytes             │
 *   │  seq (monotonic counter)     │  type      │  payload             │
 *   └──────────────────────────────┴────────────┴──────────────────────┘
 *
 *   type 0x01 = audio PCM/Opus payload
 *
 * JSON push frames carry seq + epoch as top-level optional fields (added by
 * FrameSequencer on the gateway before sending). The epoch is a session-scoped
 * counter that increments on each reconnect; it lets the client detect whether
 * a seq gap is a true miss or a reconnect restart. epoch is NOT carried in the
 * binary header — it is carried on JSON frames generally: the client first
 * learns the current epoch from auth.ok / session.ready, and again on the
 * stream.resumed reply after reconnect. On a reconnect the client requests
 * replay by carrying a `resume` object in session.configure (NOT a separate
 * frame); the gateway replies with stream.resumed.
 */

import { z } from "zod";
import { conversationFeedItemSchema } from "./conversation.ts";
import {
  conversationActivateSchema,
  sessionCreatedEventSchema,
  sessionNewSchema,
  sessionSwitchedEventSchema,
  sessionsDeletedEventSchema,
  sessionsErrorSchema,
  sessionsRenamedEventSchema,
} from "./sessions.ts";

// ─── Shared seq/epoch extension for gateway push frames ───
//
// Every gateway → client JSON frame optionally carries seq (monotonic frame
// counter within the epoch) and epoch (increments on each server reconnect).
// Both are non-negative integers; absence means the frame pre-dates sequencing.

const seqEpochFields = {
  seq: z.number().int().nonnegative().optional(),
  epoch: z.number().int().nonnegative().optional(),
} as const;

function withSeqEpoch<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.extend(seqEpochFields);
}

// withSeq: for frames that already have a required `epoch` field of their own
// (e.g. stream.resumed). Adding seq only avoids overwriting epoch as optional.
function withSeq<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  return schema.extend({ seq: z.number().int().nonnegative().optional() });
}

// ─── Client → Gateway Messages ───

/**
 * Client kind sent in session.configure so the gateway can apply
 * client-type-aware policy (e.g. headless devices like the cube ignore the
 * per-user `ttsEnabled` preference because they have no UI to surface text).
 *
 * REQUIRED — every client MUST declare its type. Missing `clientType` is a
 * protocol error; the gateway fails the session loudly rather than silently
 * defaulting, so policy gates never quietly mis-classify a new client kind.
 */
export const clientTypeSchema = z.enum(["webui", "cube", "mobile"]);
export type ClientType = z.infer<typeof clientTypeSchema>;

// Resume request carried INSIDE session.configure on a reconnect. Folding it
// into configure (rather than a separate stream.resume frame) makes the
// gateway's resume decision a synchronous read off the one parsed configure
// message — no same-tick frame-ordering race. Present only on a reconnect with
// a non-zero cursor; omitted on a fresh connect (nothing to replay).
export const sessionConfigureResumeSchema = z.object({
  epoch: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
});
export type SessionConfigureResume = z.infer<typeof sessionConfigureResumeSchema>;

export const sessionConfigureSchema = z.object({
  type: z.literal("session.configure"),
  language: z.enum(["en", "zh"]).default("en"),
  capabilities: z.object({
    supports: z.array(z.string()),
  }),
  clientType: clientTypeSchema,
  /**
   * Stable per-device identifier. REQUIRED — the client supplies the same
   * value on every connection so the gateway can key the per-device replay
   * buffer across reconnects (Task 3.8). A fresh connect gets a fresh buffer
   * for this deviceId; a reconnect reuses it.
   */
  deviceId: z.string().min(1),
  /**
   * Optional resume request (Slice 3 hardening). When present, the gateway
   * attempts a per-device buffer resume (replay frames since lastSeq within
   * epoch) instead of a fresh setup. Read synchronously off this frame — there
   * is no separate stream.resume frame.
   */
  resume: sessionConfigureResumeSchema.optional(),
  /**
   * Optional — the Hermes conversation/thread id the client is currently
   * displaying. This is the same value the client receives as `sessionId` on
   * `session.created` / `session.switched` and sends back in
   * `conversation.activate.sessionId`. It is NOT the per-WS connection id
   * (`session.ready.sessionId`). Sent on (re)connect so the gateway re-anchors
   * the thread for the next message instead of forking. Omitted on a fresh chat.
   */
  conversationId: z.string().min(1).optional(),
  /**
   * Optional — the chat-surface id (one browser tab / one mobile app instance).
   * Layers on top of `deviceId`; does NOT replace it (2026-06-14 surface-
   * isolation design §1). Web mints a per-tab UUID in sessionStorage; mobile
   * sends `surfaceId = deviceId`. The gateway keys the ACP wire pool / resume
   * buffer / replay attachment by this value so each surface is isolated.
   * OMITTED by old clients → the gateway falls back to `deviceId` (no break).
   */
  surfaceId: z.string().min(1).optional(),
});

/**
 * Turn-authority mode for a client audio stream (2026-07-17 hold/toggle-talk
 * split design §4). "manual" = hold-to-talk: user press/release is the sole
 * turn boundary — the gateway relays this to STT so Smart-Turn v3 is
 * bypassed. "semantic" = today's continuous mode: Smart-Turn v3 decides turn
 * boundaries (unchanged). z.union of literals (not this file's usual z.enum)
 * was an explicit spec-slice directive — both infer the same "manual"|"semantic"
 * TS union, so don't "fix" it back without checking the hold/toggle spec.
 */
export const turnModeSchema = z.union([z.literal("manual"), z.literal("semantic")]);
export type TurnMode = z.infer<typeof turnModeSchema>;

export const audioStartSchema = z.object({
  type: z.literal("audio.start"),
  /**
   * Optional; absent (or omitted by old clients / webui) defaults to
   * "semantic" so back-compat is automatic — no client-side migration
   * required. Mobile sets "manual" for a hold-to-talk press.
   */
  turnMode: turnModeSchema.default("semantic"),
});

export const audioEndSchema = z.object({
  type: z.literal("audio.end"),
});

export const textInputSchema = z.object({
  type: z.literal("text.input"),
  text: z.string().min(1).max(10000),
  pendingId: z.string().optional(),
});

// Client → gateway answer to a `permission.request` (spec §7.1). Keyed by
// `requestId`, not `toolCallId`: the gateway may have already resolved the
// request (timeout, interrupt) by the time this lands, and matching on the
// prompt id makes that late answer a clean no-op instead of a stale approval
// applied to a different call. `approved` is REQUIRED — there is no
// "unanswered" wire value, because a missing decision must never read as yes.
export const permissionResponseSchema = z.object({
  type: z.literal("permission.response"),
  requestId: z.string(),
  approved: z.boolean(),
});
export type PermissionResponse = z.infer<typeof permissionResponseSchema>;

export const sessionEndSchema = z.object({
  type: z.literal("session.end"),
});

export const pingSchema = z.object({
  type: z.literal("ping"),
});

// Explicit user-initiated interrupt (UI button, Escape key). Distinct
// from barge-in, which is mic-onset-inferred. Server treats it as a
// hard abort: aborts the cycle, cancels interruptable tasks, stops
// audio playback. No payload — the interrupt is idempotent.
export const interruptSchema = z.object({
  type: z.literal("interrupt"),
});

// NOTE: the resume request is carried INSIDE session.configure (see
// sessionConfigureSchema.resume) — there is no separate stream.resume frame.
// The gateway → client reply is stream.resumed (below), still its own frame.

export const clientMessageSchema = z.discriminatedUnion("type", [
  sessionConfigureSchema,
  audioStartSchema,
  audioEndSchema,
  textInputSchema,
  permissionResponseSchema,
  sessionEndSchema,
  pingSchema,
  interruptSchema,
  sessionNewSchema,
  conversationActivateSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ─── Gateway → Client Messages ───

// ─── Auth handshake (pre-journal) ───
//
// `auth.ok` / `auth.error` are sent before `session.configure` mints this
// connection's FrameJournal, so they go out unsequenced — both SDKs treat an
// absent seq as "not sequenced" and pass it through. Unsequenced is NOT
// unvalidated: like every other outbound frame they are constructed as a
// `GatewayMessage` and parsed by `sendGatewayFrame` before any bytes leave.
//
// The shape below is the one the clients actually decode — `shared/mobile-sdk`
// `ServerMessage.AuthOk` requires `user`, and the web SDK reads only the type.
// The previous `{ sessionId, role }` stub matched neither sender nor consumer:
// `ws-auth-gate.ts` never populated it, so routing the real frame through
// validation against that stub would have made every auth ack fail zod and get
// dropped, hanging every client at connect.

/** The authenticated user, as the clients render it (avatar + display name).
 *  `avatarTint` stays a plain string rather than the tint enum on purpose: a
 *  legacy or hand-edited user record with an unknown tint must degrade to a
 *  wrong colour, never to a dropped auth ack. */
const authUserSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  isAdmin: z.boolean(),
  avatarTint: z.string(),
});

export const authOkSchema = z.object({
  type: z.literal("auth.ok"),
  user: authUserSchema,
});
export type AuthOkMessage = z.infer<typeof authOkSchema>;

/** Sent immediately before the gateway closes the socket (RFC 6455 1008).
 *  `code` is the stable machine token the clients branch on (`auth-required`,
 *  `auth-timeout`, `session-limit`, `invalid-user-record`, or a token
 *  validation error); `message` is human-readable detail. */
export const authErrorSchema = z.object({
  type: z.literal("auth.error"),
  code: z.string(),
  message: z.string(),
});
export type AuthErrorMessage = z.infer<typeof authErrorSchema>;

export const sessionReadySchema = z.object({
  type: z.literal("session.ready"),
  sessionId: z.string(),
  audioEncoding: z.string(),
  inputSampleRate: z.number(),
  outputSampleRate: z.number(),
  enabledEffects: z.array(z.string()),
  /** Playback tuning hints sent by the gateway. Optional for backwards
   *  compatibility — webui falls back to DEFAULT_* constants when absent. */
  playback: z
    .object({
      minEagerEndMs: z.number().int().min(0),
      preemptFadeoutMs: z.number().int().min(0),
    })
    .optional(),
});

// ─── Turn lifecycle (Sentient 2.0 native orchestrator, spec §7) ───
//
// A "turn" is one native ReAct run inside a `SessionRuntime`: stimulus in →
// zero or more tool round-trips → final text out. It replaces the pre-2.0
// "cycle", which was named for one Hermes round-trip — a unit the native
// brain no longer has. `turnId` is minted by `SessionRuntime`
// (crypto.randomUUID) and is the ONLY turn identity on the wire; there is no
// `cycleId` in 2.0.
//
// Turn frames NEVER imply audio control. Per spec §4.6/§7.2 the gateway does
// not stop its own TTS: a new `turn.started` must not cancel or replace
// in-flight audio — the client queues behind it. Only `playback.stop`
// (barge-in / interrupt) flushes audio.

export const turnTriggerSchema = z.enum(["user", "background-completion"]);
export type TurnTrigger = z.infer<typeof turnTriggerSchema>;

export const turnStartedSchema = z.object({
  type: z.literal("turn.started"),
  turnId: z.string(),
  /** What caused this turn: a person's message/utterance, or a background
   *  `delegateTask` completion arriving as a stimulus (spec §4.4). Clients
   *  use it to label the bubble; they never infer it. */
  trigger: turnTriggerSchema,
});
export type TurnStartedMessage = z.infer<typeof turnStartedSchema>;

export const turnTextDeltaSchema = z.object({
  type: z.literal("turn.text.delta"),
  /** REQUIRED. Plan 2's interim `response.text.delta` omitted this, which
   *  made two overlapping turns (§7.2's back-to-back follow-up) impossible to
   *  route to the right bubble. That was a bug; this frame fixes it. */
  turnId: z.string(),
  text: z.string(),
});
export type TurnTextDeltaMessage = z.infer<typeof turnTextDeltaSchema>;

export const turnCompletedSchema = z.object({
  type: z.literal("turn.completed"),
  turnId: z.string(),
});
export type TurnCompletedMessage = z.infer<typeof turnCompletedSchema>;

/** Why an assistant turn was cut short (spec §4.7). Mirrors the gateway's
 *  `CutoffKind` (gateway/src/store/entry-types.ts) and the cutoff marker
 *  stamped on the committed partial in the session store — one vocabulary,
 *  store and wire. */
export const turnCutoffSchema = z.enum(["interrupt", "barge-in"]);
export type TurnCutoff = z.infer<typeof turnCutoffSchema>;

export const turnAbortedSchema = z.object({
  type: z.literal("turn.aborted"),
  turnId: z.string(),
  cutoff: turnCutoffSchema,
});
export type TurnAbortedMessage = z.infer<typeof turnAbortedSchema>;

/** Tool-tile status. Deliberately NOT the retired `task.update` vocabulary
 *  ("finished"|"cancelled"|"failed") — the native loop only distinguishes
 *  in-flight, succeeded, and errored. */
export const turnToolStatusSchema = z.enum(["running", "done", "error"]);
export type TurnToolStatus = z.infer<typeof turnToolStatusSchema>;

export const turnToolUpdateSchema = z.object({
  type: z.literal("turn.tool.update"),
  turnId: z.string(),
  /** Provider-assigned id for this call; the client's dedupe key so one tile
   *  transitions in place instead of stacking. */
  toolCallId: z.string(),
  toolName: z.string(),
  status: turnToolStatusSchema,
  /** Present only on a BACKGROUND dispatch's "running" update (the
   *  `delegateTask` archetype). Its completion arrives later as a
   *  `delegation.progress` frame, never as a second `turn.tool.update`. */
  taskId: z.string().optional(),
  /** Short, already-truncated preview of the tool's arguments for the tile.
   *  Never the full argument object — clients render this verbatim. */
  argsPreview: z.string(),
  startedAtMs: z.number().int().nonnegative(),
  /** Present once the call reaches a terminal status. */
  endedAtMs: z.number().int().nonnegative().optional(),
});
export type TurnToolUpdateMessage = z.infer<typeof turnToolUpdateSchema>;

/** Wire encoding of the outbound TTS byte stream. Exactly two values — this
 *  is NOT the free-form `session.ready.audioEncoding` string. */
export const turnAudioEncodingSchema = z.enum(["opus", "pcm"]);
export type TurnAudioEncoding = z.infer<typeof turnAudioEncodingSchema>;

export const turnAudioStartSchema = z.object({
  type: z.literal("turn.audio.start"),
  turnId: z.string(),
  encoding: turnAudioEncodingSchema,
  sampleRate: z.number().int().positive(),
});
export type TurnAudioStartMessage = z.infer<typeof turnAudioStartSchema>;

export const turnAudioDoneSchema = z.object({
  type: z.literal("turn.audio.done"),
  turnId: z.string(),
});
export type TurnAudioDoneMessage = z.infer<typeof turnAudioDoneSchema>;

// ─── Permission mediation (spec §5.3 L3 PDP, §7.1 prompt UI) ───
//
// A `confirm` decision on a side-effecting tool blocks the turn until the
// user answers. The gateway sends `permission.request`; the client renders a
// real dialog and replies with `permission.response`. `permission.resolved`
// is the server's closing signal — it fires on EVERY resolution path,
// including the ones the client did not cause (2-minute timeout → auto-deny,
// or the turn being interrupted), so a dialog is never left orphaned on
// screen. Fail-closed: a timeout is a denial, never an implicit approval.

export const permissionRequestSchema = z.object({
  type: z.literal("permission.request"),
  /** Correlation id for this prompt. Distinct from `toolCallId`: one tool
   *  call yields at most one prompt, but the client answers by `requestId`
   *  so a late answer to a superseded prompt is trivially ignorable. */
  requestId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  /** The ACTUAL argument values the PDP is mediating (§2.2: authorization is
   *  value-aware). Rendered in the dialog so the user approves what will
   *  really happen, not a tool name. */
  args: z.record(z.unknown()),
  /** Human-readable one-line summary of the action, produced by the gateway. */
  description: z.string(),
  /** Absolute epoch-ms deadline. The client dismisses at this point without
   *  waiting for `permission.resolved`, so a dropped frame can't hang the UI. */
  expiresAtMs: z.number().int().nonnegative(),
});
export type PermissionRequestMessage = z.infer<typeof permissionRequestSchema>;

export const permissionOutcomeSchema = z.enum(["allowed", "denied", "timeout"]);
export type PermissionOutcome = z.infer<typeof permissionOutcomeSchema>;

export const permissionResolvedSchema = z.object({
  type: z.literal("permission.resolved"),
  requestId: z.string(),
  outcome: permissionOutcomeSchema,
});
export type PermissionResolvedMessage = z.infer<typeof permissionResolvedSchema>;

// ─── Delegation progress (spec §5.4) ───
//
// Background `delegateTask` work outlives the turn that dispatched it. This
// frame is the client's only live view of it; the eventual completion also
// re-enters the brain as a stimulus, producing a NEW turn (§4.5).

export const delegationStatusSchema = z.enum(["running", "done", "error"]);
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

export const delegationProgressSchema = z.object({
  type: z.literal("delegation.progress"),
  taskId: z.string(),
  /** The turn that DISPATCHED the task — not necessarily the turn that is
   *  live when this frame arrives. */
  turnId: z.string(),
  /** Delegated agent name, e.g. "hermes". */
  agent: z.string(),
  status: delegationStatusSchema,
  /** Short human-readable progress/failure note. Never the full result. */
  note: z.string().optional(),
});
export type DelegationProgressMessage = z.infer<typeof delegationProgressSchema>;

// ─── Conversation Sync (session-scoped feed) ───

export const conversationSnapshotSchema = z.object({
  type: z.literal("conversation.snapshot"),
  items: z.array(conversationFeedItemSchema),
});

// `turnId` is the gateway-owned join key between a live streaming bubble
// (turn.text.delta) and its committed entry. It is carried on the FRAME, not
// on the item (the feed item deliberately strips turn/task plumbing — see
// conversation.ts). Clients read it here to render ONE bubble per reply
// instead of reverse-engineering it client-side. Optional because some
// entries have no originating turn (a user-input echo, an out-of-band
// activate entry).
export const conversationEntrySchema = z.object({
  type: z.literal("conversation.entry"),
  turnId: z.string().optional(),
  item: conversationFeedItemSchema,
});

// ─── Shared Gateway → Client ───

export const errorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const pongSchema = z.object({
  type: z.literal("pong"),
});

export const sessionExpiredSchema = z.object({
  type: z.literal("session.expired"),
  reason: z.string(),
});

// Tell the client to drop any playing/buffered audio for the named turn
// immediately. Fires on mic-onset (barge-in) and hard interrupt ONLY — never
// on a new turn (spec §4.6/§7.2: the gateway does not stop its own audio).
// The client filters further binary audio for a turn whose `playback.stop`
// it has already received.
export const playbackStopSchema = z.object({
  type: z.literal("playback.stop"),
  turnId: z.string(),
  reason: turnCutoffSchema,
});
export type PlaybackStopMessage = z.infer<typeof playbackStopSchema>;

// Resume acknowledgement — sent by the gateway after processing stream.resume.
// recovered=true means the buffer contained frames in [fromSeq, toSeq] that
// will be replayed. recovered=false means the epoch has rolled over or the
// buffer was empty; client should treat this as a clean reconnect.
//
// The base schema holds the domain fields (epoch is REQUIRED here — it is
// always present on this frame). The wire schema adds the optional seq stamp
// that FrameSequencer injects on the way out. StreamResumed is typed from the
// wire schema so client code reading .seq on a typed value is valid.
const streamResumedBaseSchema = z.object({
  type: z.literal("stream.resumed"),
  recovered: z.boolean(),
  epoch: z.number().int().nonnegative(),
  fromSeq: z.number().int().nonnegative().optional(),
  toSeq: z.number().int().nonnegative().optional(),
});
export const streamResumedSchema = withSeq(streamResumedBaseSchema);
export type StreamResumed = z.infer<typeof streamResumedSchema>;

/**
 * Invariant: every entry MUST be wrapped with `withSeqEpoch` (or `withSeq` for
 * frames that already require `epoch` in their own schema, e.g. stream.resumed)
 * so the client can parse the sequencer-stamped seq/epoch fields.
 */
export const gatewayMessageSchema = z.discriminatedUnion("type", [
  withSeqEpoch(authOkSchema),
  withSeqEpoch(authErrorSchema),
  withSeqEpoch(sessionReadySchema),
  withSeqEpoch(turnStartedSchema),
  withSeqEpoch(turnTextDeltaSchema),
  withSeqEpoch(turnCompletedSchema),
  withSeqEpoch(turnAbortedSchema),
  withSeqEpoch(turnToolUpdateSchema),
  withSeqEpoch(turnAudioStartSchema),
  withSeqEpoch(turnAudioDoneSchema),
  withSeqEpoch(permissionRequestSchema),
  withSeqEpoch(permissionResolvedSchema),
  withSeqEpoch(delegationProgressSchema),
  withSeqEpoch(conversationSnapshotSchema),
  withSeqEpoch(conversationEntrySchema),
  withSeqEpoch(errorSchema),
  withSeqEpoch(pongSchema),
  withSeqEpoch(sessionExpiredSchema),
  withSeqEpoch(playbackStopSchema),
  withSeqEpoch(sessionsDeletedEventSchema),
  withSeqEpoch(sessionsRenamedEventSchema),
  withSeqEpoch(sessionCreatedEventSchema),
  withSeqEpoch(sessionSwitchedEventSchema),
  withSeqEpoch(sessionsErrorSchema),
  streamResumedSchema, // already wrapped with withSeq; epoch is required on this frame
]);

export type GatewayMessage = z.infer<typeof gatewayMessageSchema>;
