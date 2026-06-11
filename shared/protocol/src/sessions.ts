import { z } from "zod";

const TITLE_MAX = 200;
const ERROR_MESSAGE_MAX = 500;

// SessionRow — the canonical client-facing shape for a chat thread.
export const sessionRowSchema = z.object({
  sessionId: z.string().min(1),
  rootId: z.string().min(1),
  title: z.string().max(TITLE_MAX),
  startedAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  isActive: z.boolean(),
});

export type SessionRow = z.infer<typeof sessionRowSchema>;

// Gateway → client: confirm + broadcast deletion.
export const sessionsDeletedEventSchema = z.object({
  type: z.literal("sessions.deleted"),
  sessionId: z.string().min(1),
});

// Gateway → client: confirm + broadcast rename.
export const sessionsRenamedEventSchema = z.object({
  type: z.literal("sessions.renamed"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX),
});

// Client → gateway: start a new chat.
export const sessionNewSchema = z.object({
  type: z.literal("session.new"),
  requestId: z.string().min(1),
});

// Gateway → client: a new session id was created (also emitted on first message of a fresh chain).
export const sessionCreatedEventSchema = z.object({
  type: z.literal("session.created"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX).optional(),
  ts: z.number().int().nonnegative(),
});

// Client → gateway: activate a conversation (lightweight replacement for the retired session.switch).
// Does not require a requestId — fire-and-forget; focuses the live stream.
// Gateway replies session.switched only — the client loads history via REST (no snapshot).
export const conversationActivateSchema = z.object({
  type: z.literal("conversation.activate"),
  sessionId: z.string().min(1),
});
export type ConversationActivate = z.infer<typeof conversationActivateSchema>;

// Gateway → client: confirms the active conversation; the client fetches history via REST (no snapshot follows).
export const sessionSwitchedEventSchema = z.object({
  type: z.literal("session.switched"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX).optional(),
  ts: z.number().int().nonnegative(),
});

// Gateway → client: failure on any sessions.* request.
// requestId is optional — conversation.activate errors have no requestId.
export const sessionsErrorSchema = z.object({
  type: z.literal("sessions.error"),
  requestId: z.string().min(1).optional(),
  code: z.enum(["forbidden", "not_found", "switching", "internal", "validation", "rate_limited"]),
  message: z.string().max(ERROR_MESSAGE_MAX),
});

export type SessionsDeletedEvent = z.infer<typeof sessionsDeletedEventSchema>;
export type SessionsRenamedEvent = z.infer<typeof sessionsRenamedEventSchema>;
export type SessionNewMessage = z.infer<typeof sessionNewSchema>;
export type SessionCreatedEvent = z.infer<typeof sessionCreatedEventSchema>;
export type SessionSwitchedEvent = z.infer<typeof sessionSwitchedEventSchema>;
export type SessionsErrorEvent = z.infer<typeof sessionsErrorSchema>;
