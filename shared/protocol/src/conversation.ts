import { z } from "zod";

// ---------------------------------------------------------------------------
// Wire DTO for the ConversationHistory sync channel.
//
// This is the CLIENT-facing shape of a conversation entry — deliberately
// narrower than the gateway's internal `ConversationEntry`. Internal
// plumbing (entry id, cycleId, taskId) is stripped; only fields the UI
// needs to render chat bubbles + the task sidebar remain.
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
// `interrupt`: cycle was hard-aborted (UI button or `interrupt` tool).
//              `cancelledTaskIds` lets the UI / model correlate tasks
//              that died with this interrupt specifically.
export const conversationAssistantCutoffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("barge-in") }),
  z.object({
    kind: z.literal("interrupt"),
    cancelledTaskIds: z.array(z.string()).readonly(),
  }),
]);
export type ConversationAssistantCutoff = z.infer<typeof conversationAssistantCutoffSchema>;

export const conversationFeedUserItemSchema = z.object({
  ts: z.number().int().nonnegative(),
  kind: z.literal("user"),
  channel: conversationUserChannelSchema,
  content: z.string(),
});

export const conversationFeedTriggerItemSchema = z.object({
  ts: z.number().int().nonnegative(),
  kind: z.literal("trigger"),
  source: z.string(),
  summary: z.string(),
});

export const conversationFeedAssistantItemSchema = z.object({
  ts: z.number().int().nonnegative(),
  kind: z.literal("assistant"),
  content: z.string(),
  cutoff: conversationAssistantCutoffSchema.optional(),
});

export const conversationFeedToolItemSchema = z.object({
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
