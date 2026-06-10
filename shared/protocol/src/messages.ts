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
import { userRoleSchema } from "./roles.ts";
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
});

export const audioStartSchema = z.object({
  type: z.literal("audio.start"),
});

export const audioEndSchema = z.object({
  type: z.literal("audio.end"),
});

export const textInputSchema = z.object({
  type: z.literal("text.input"),
  text: z.string().min(1).max(10000),
  pendingId: z.string().optional(),
});

export const toolConfirmSchema = z.object({
  type: z.literal("tool.confirm"),
  toolCallId: z.string(),
  approved: z.boolean(),
});

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
  toolConfirmSchema,
  sessionEndSchema,
  pingSchema,
  interruptSchema,
  sessionNewSchema,
  conversationActivateSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ─── Gateway → Client Messages ───

export const authOkSchema = z.object({
  type: z.literal("auth.ok"),
  sessionId: z.string(),
  role: userRoleSchema,
});

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

// ─── Cycle Lifecycle ───

export const cycleStartedSchema = z.object({
  type: z.literal("cycle.started"),
  cycleId: z.string(),
  triggerKind: z.string(),
  triggerSource: z.string(),
});

export const connectorCancelledSchema = z.object({
  type: z.literal("connector.cancelled"),
  connector: z.string(),
  cycleId: z.string(),
  taskId: z.string(),
  reason: z.string(),
});

export const cycleAbortedSchema = z.object({
  type: z.literal("cycle.aborted"),
  cycleId: z.string(),
  reason: z.string(),
});

export const cycleCompletedSchema = z.object({
  type: z.literal("cycle.completed"),
  cycleId: z.string(),
  effectsInvoked: z.array(z.string()),
});

// ─── Connector Messages ───

export const connectorTranscriptFinalSchema = z.object({
  type: z.literal("connector.transcript.final"),
  connector: z.literal("UserAudioInputConnector"),
  text: z.string(),
  language: z.string(),
});

export const connectorAudioStartSchema = z.object({
  type: z.literal("connector.audio.start"),
  connector: z.literal("AssistantAudioResponseConnector"),
  cycleId: z.string(),
  taskId: z.string(),
  encoding: z.string(),
  sampleRate: z.number(),
});

export const connectorAudioDoneSchema = z.object({
  type: z.literal("connector.audio.done"),
  connector: z.string(),
  cycleId: z.string(),
  taskId: z.string(),
});

// ─── Streaming assistant content (chat-bubble source) ───
//
// The model's `content` field is the canonical user-facing reply.
// Delta frames stream mid-cycle; done commits the bubble to history.

export const messageDeltaSchema = z.object({
  type: z.literal("message.delta"),
  cycleId: z.string(),
  delta: z.string(),
});

export const messageDoneSchema = z.object({
  type: z.literal("message.done"),
  cycleId: z.string(),
});

// ─── Cognition Status ───

export const cognitionStatusSchema = z.object({
  type: z.literal("cognition.status"),
  state: z.enum(["idle", "thinking", "acting"]),
  runningEffects: z.array(z.string()),
});

// ─── Conversation Sync (session-scoped feed) ───

export const conversationSnapshotSchema = z.object({
  type: z.literal("conversation.snapshot"),
  items: z.array(conversationFeedItemSchema),
});

export const conversationEntrySchema = z.object({
  type: z.literal("conversation.entry"),
  item: conversationFeedItemSchema,
});

// ─── Task lifecycle (live per-task status for the UI sidebar) ───
//
// Fires once at register time with status="running" and again at
// deregister with the terminal status. Client dedups by taskId so the
// same sidebar row transitions in place. Separate from the conversation
// feed because ConversationHistory only records terminal state (for LLM
// context) — the running state is a UI concern.

export const taskStatusSchema = z.enum(["running", "finished", "cancelled", "failed"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskUpdateSchema = z.object({
  type: z.literal("task.update"),
  taskId: z.string(),
  toolName: z.string(),
  cycleId: z.string(),
  status: taskStatusSchema,
  /** Short auto-derived preview of the tool's args for the UI sidebar. */
  argsPreview: z.string(),
  startedAtMs: z.number().int().nonnegative(),
  /** Present once the task reaches a terminal state. */
  endedAtMs: z.number().int().nonnegative().optional(),
});
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;

// ─── Shared Gateway → Client ───

export const toolConfirmRequestSchema = z.object({
  type: z.literal("tool.confirm_request"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()),
  description: z.string(),
});

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

// Tell the client to drop any playing/buffered audio for the named
// cycle immediately. Fires on: mic-onset (barge-in) and hard interrupt.
// Client filters further incoming audio.frame messages whose cycleId
// matches a `playback.stop` already received.
export const playbackStopSchema = z.object({
  type: z.literal("playback.stop"),
  cycleId: z.string(),
  reason: z.enum(["barge-in", "interrupt"]),
});

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
  withSeqEpoch(sessionReadySchema),
  withSeqEpoch(cycleStartedSchema),
  withSeqEpoch(connectorCancelledSchema),
  withSeqEpoch(cycleAbortedSchema),
  withSeqEpoch(cycleCompletedSchema),
  withSeqEpoch(connectorTranscriptFinalSchema),
  withSeqEpoch(connectorAudioStartSchema),
  withSeqEpoch(connectorAudioDoneSchema),
  withSeqEpoch(messageDeltaSchema),
  withSeqEpoch(messageDoneSchema),
  withSeqEpoch(cognitionStatusSchema),
  withSeqEpoch(conversationSnapshotSchema),
  withSeqEpoch(conversationEntrySchema),
  withSeqEpoch(taskUpdateSchema),
  withSeqEpoch(toolConfirmRequestSchema),
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
