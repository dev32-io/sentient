import { z } from "zod";
import { conversationFeedItemSchema } from "./conversation.ts";
import { userRoleSchema } from "./roles.ts";
import {
  sessionCreatedEventSchema,
  sessionNewSchema,
  sessionSwitchSchema,
  sessionSwitchedEventSchema,
  sessionsDeleteResultSchema,
  sessionsDeleteSchema,
  sessionsDeletedEventSchema,
  sessionsErrorSchema,
  sessionsListResultSchema,
  sessionsListSchema,
  sessionsRenameResultSchema,
  sessionsRenameSchema,
  sessionsRenamedEventSchema,
  sessionsSearchResultSchema,
  sessionsSearchSchema,
} from "./sessions.ts";

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
export const clientTypeSchema = z.enum(["webui", "cube"]);
export type ClientType = z.infer<typeof clientTypeSchema>;

export const sessionConfigureSchema = z.object({
  type: z.literal("session.configure"),
  language: z.enum(["en", "zh"]).default("en"),
  capabilities: z.object({
    supports: z.array(z.string()),
  }),
  clientType: clientTypeSchema,
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

export const clientMessageSchema = z.discriminatedUnion("type", [
  sessionConfigureSchema,
  audioStartSchema,
  audioEndSchema,
  textInputSchema,
  toolConfirmSchema,
  sessionEndSchema,
  pingSchema,
  interruptSchema,
  sessionsListSchema,
  sessionsSearchSchema,
  sessionsDeleteSchema,
  sessionsRenameSchema,
  sessionNewSchema,
  sessionSwitchSchema,
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

export const gatewayMessageSchema = z.discriminatedUnion("type", [
  authOkSchema,
  sessionReadySchema,
  cycleStartedSchema,
  connectorCancelledSchema,
  cycleAbortedSchema,
  cycleCompletedSchema,
  connectorTranscriptFinalSchema,
  connectorAudioStartSchema,
  connectorAudioDoneSchema,
  messageDeltaSchema,
  messageDoneSchema,
  cognitionStatusSchema,
  conversationSnapshotSchema,
  conversationEntrySchema,
  taskUpdateSchema,
  toolConfirmRequestSchema,
  errorSchema,
  pongSchema,
  sessionExpiredSchema,
  playbackStopSchema,
  sessionsListResultSchema,
  sessionsSearchResultSchema,
  sessionsDeleteResultSchema,
  sessionsDeletedEventSchema,
  sessionsRenameResultSchema,
  sessionsRenamedEventSchema,
  sessionCreatedEventSchema,
  sessionSwitchedEventSchema,
  sessionsErrorSchema,
]);

export type GatewayMessage = z.infer<typeof gatewayMessageSchema>;
