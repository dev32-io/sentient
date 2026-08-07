import { z } from "zod";

// ---------------------------------------------------------------------------
// Wire DTO for the ConversationHistory sync channel.
//
// This is the CLIENT-facing shape of a conversation entry — deliberately
// narrower than the gateway's internal `ConversationEntry`. Internal
// plumbing (taskId) is stripped from the ITEM; only fields the UI needs to
// render chat bubbles + the task sidebar remain.
//
// NOTE on turnId: it is stripped from the ITEM but carried on the
// `conversation.entry` FRAME (see messages.ts conversationEntrySchema). Clients
// re-attach the frame turnId to a live assistant entry so the committed twin
// joins its streaming bubble by id — the client never invents/derives the id.
//
// `entryId` — stable, opaque string id assigned at commit time (live path)
// or derived deterministically from position (REST history path). Clients
// use it for dedupe on replay (Slice 3) and as a mirror key (Slice 4).
// It is REQUIRED on all feed items; a missing entryId is a schema error.
//
// Shape stays a discriminated union on `kind`, so the client can filter
// without string parsing:
//   feed.filter(i => i.kind === "tool")   → sidebar rows
//   feed.filter(i => i.kind === "user" || i.kind === "assistant") → chat
// ---------------------------------------------------------------------------

export const conversationUserChannelSchema = z.enum(["text", "speech"]);
export type ConversationUserChannel = z.infer<typeof conversationUserChannelSchema>;

export const conversationToolStatusSchema = z.enum(["finished", "cancelled", "failed"]);
export type ConversationToolStatus = z.infer<typeof conversationToolStatusSchema>;

// Why an assistant reply was cut short. Absent on normal completions.
// `barge-in`: user spoke mid-TTS, playback stopped; LLM stream finished
//             normally but the audio was interrupted.
// `interrupt`: turn was hard-aborted (UI button or `interrupt` tool).
//              `cancelledTaskIds` is STRUCTURALLY ALWAYS EMPTY: an interrupt
//              cancels the turn and nothing else, and nothing anywhere
//              cancels a background task (gateway tools/delegate-task.ts).
//              The field is kept because removing it is a wire change, and
//              because a later model-facing task-management tool — which
//              cancels by NAMED taskId — is what would finally populate it.
//              Never render it as "these died with your Stop"; nothing did.
export const conversationAssistantCutoffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("barge-in") }),
  z.object({
    kind: z.literal("interrupt"),
    cancelledTaskIds: z.array(z.string()).readonly(),
  }),
]);
export type ConversationAssistantCutoff = z.infer<typeof conversationAssistantCutoffSchema>;

export const conversationFeedUserItemSchema = z.object({
  entryId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal("user"),
  channel: conversationUserChannelSchema,
  content: z.string(),
  pendingId: z.string().optional(),
});

export const conversationFeedTriggerItemSchema = z.object({
  entryId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal("trigger"),
  source: z.string(),
  summary: z.string(),
});

export const conversationFeedAssistantItemSchema = z.object({
  entryId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal("assistant"),
  /** WHICH REPLY this item is. Carried on the ITEM, not only on the
   *  `conversation.entry` frame: a window that attaches mid-turn is answered
   *  with a snapshot, which has no frame to hang it on, and without it that
   *  window cannot tell which committed row its live bubble is painting. */
  replyId: z.string().optional(),
  content: z.string(),
  cutoff: conversationAssistantCutoffSchema.optional(),
});

export const conversationFeedToolItemSchema = z.object({
  entryId: z.string(),
  ts: z.number().int().nonnegative(),
  kind: z.literal("tool"),
  toolName: z.string(),
  status: conversationToolStatusSchema,
  summary: z.string(),
});

export const conversationFeedItemSchema = z.discriminatedUnion("kind", [
  conversationFeedUserItemSchema,
  conversationFeedTriggerItemSchema,
  conversationFeedAssistantItemSchema,
  conversationFeedToolItemSchema,
]);

export type ConversationFeedItem = z.infer<typeof conversationFeedItemSchema>;
