import { z } from "zod";

const TITLE_MAX = 200;
const QUERY_MAX = 200;
const LIST_LIMIT_MAX = 100;
const SEARCH_LIMIT_MAX = 50;
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

// Helper — disallow ASCII control characters in user-supplied titles.
// Rejects any character in the C0 (0x00-0x1F) or C1 (0x7F-0x9F) control ranges.
const safeTitle = z
  .string()
  .max(TITLE_MAX)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit control-char rejection is the purpose of this guard
  .refine((s) => !/[\x00-\x1F\x7F-\x9F]/.test(s), {
    message: "title contains control characters",
  });

// Client → gateway: list a page of sessions.
export const sessionsListSchema = z.object({
  type: z.literal("sessions.list"),
  requestId: z.string().min(1),
  limit: z.number().int().positive().max(LIST_LIMIT_MAX),
  offset: z.number().int().nonnegative(),
});

// Gateway → client: list result.
export const sessionsListResultSchema = z.object({
  type: z.literal("sessions.list.result"),
  requestId: z.string().min(1),
  items: z.array(sessionRowSchema),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

// Client → gateway: full-text search.
export const sessionsSearchSchema = z.object({
  type: z.literal("sessions.search"),
  requestId: z.string().min(1),
  q: z.string().min(1).max(QUERY_MAX),
  limit: z.number().int().positive().max(SEARCH_LIMIT_MAX),
});

// Gateway → client: search result.
export const sessionsSearchResultSchema = z.object({
  type: z.literal("sessions.search.result"),
  requestId: z.string().min(1),
  items: z.array(sessionRowSchema),
});

// Client → gateway: delete a session.
export const sessionsDeleteSchema = z.object({
  type: z.literal("sessions.delete"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
});

// Gateway → client: request-correlated delete result. Pairs the inbound
// `sessions.delete { requestId }` with a matching response so the SDK's
// `request<T>` Promise resolves cleanly. The broadcast event below
// (`sessions.deleted`) still fans out to every change-listener for live
// UI updates.
export const sessionsDeleteResultSchema = z.object({
  type: z.literal("sessions.delete.result"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
});

// Gateway → client: confirm + broadcast deletion.
export const sessionsDeletedEventSchema = z.object({
  type: z.literal("sessions.deleted"),
  sessionId: z.string().min(1),
});

// Client → gateway: rename a session.
export const sessionsRenameSchema = z.object({
  type: z.literal("sessions.rename"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  title: safeTitle,
});

// Gateway → client: request-correlated rename result. Same split as
// `sessions.delete.result` — resolves the SDK Promise; the broadcast
// event below drives change listeners.
export const sessionsRenameResultSchema = z.object({
  type: z.literal("sessions.rename.result"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX),
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

// Client → gateway: switch the active chain.
export const sessionSwitchSchema = z.object({
  type: z.literal("session.switch"),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
});

// Gateway → client: confirms a switch — followed by a conversation.snapshot.
export const sessionSwitchedEventSchema = z.object({
  type: z.literal("session.switched"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX).optional(),
  ts: z.number().int().nonnegative(),
});

// Gateway → client: failure on any sessions.* request.
export const sessionsErrorSchema = z.object({
  type: z.literal("sessions.error"),
  requestId: z.string().min(1),
  code: z.enum(["forbidden", "not_found", "switching", "internal", "validation"]),
  message: z.string().max(ERROR_MESSAGE_MAX),
});

export type SessionsListMessage = z.infer<typeof sessionsListSchema>;
export type SessionsListResult = z.infer<typeof sessionsListResultSchema>;
export type SessionsSearchMessage = z.infer<typeof sessionsSearchSchema>;
export type SessionsSearchResult = z.infer<typeof sessionsSearchResultSchema>;
export type SessionsDeleteMessage = z.infer<typeof sessionsDeleteSchema>;
export type SessionsDeleteResult = z.infer<typeof sessionsDeleteResultSchema>;
export type SessionsDeletedEvent = z.infer<typeof sessionsDeletedEventSchema>;
export type SessionsRenameMessage = z.infer<typeof sessionsRenameSchema>;
export type SessionsRenameResult = z.infer<typeof sessionsRenameResultSchema>;
export type SessionsRenamedEvent = z.infer<typeof sessionsRenamedEventSchema>;
export type SessionNewMessage = z.infer<typeof sessionNewSchema>;
export type SessionCreatedEvent = z.infer<typeof sessionCreatedEventSchema>;
export type SessionSwitchMessage = z.infer<typeof sessionSwitchSchema>;
export type SessionSwitchedEvent = z.infer<typeof sessionSwitchedEventSchema>;
export type SessionsErrorEvent = z.infer<typeof sessionsErrorSchema>;
