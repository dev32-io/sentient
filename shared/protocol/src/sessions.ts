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

/**
 * How strongly the client is asking for a new chat.
 *
 * `explicit` is a person pressing "+": the connection is unbound from whatever
 * session it held and lands on a fresh draft. `implicit` is the app simply
 * starting up with no route id — mobile fires `session.new` on EVERY launch,
 * twice per launch (`ChatViewModel.init` turns a null route id into
 * `sendNewChat()`), so treating that as "+" would fork the conversation on
 * every app open and destroy reload-convergence.
 *
 * Defaulted rather than required: an old client (and the cube) sends neither
 * field and keeps exactly the pre-existing behaviour — the gateway answers
 * with the session already bound to the connection.
 */
export const sessionNewIntentSchema = z.enum(["explicit", "implicit"]);
export type SessionNewIntent = z.infer<typeof sessionNewIntentSchema>;

// Client → gateway: start a new chat.
export const sessionNewSchema = z.object({
  type: z.literal("session.new"),
  requestId: z.string().min(1),
  intent: sessionNewIntentSchema.default("implicit"),
});

// Gateway → client: a new session id was created (also emitted on first message of a fresh chain).
export const sessionCreatedEventSchema = z.object({
  type: z.literal("session.created"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX).optional(),
  ts: z.number().int().nonnegative(),
});

/**
 * Gateway → client: "you have no session yet — hold this key."
 *
 * A connection that presents no session id (a fresh tab, a first launch, or the
 * window right after "+") is a DRAFT: no row, no id, nothing in the session
 * list. Ten opened tabs leave no trace. The id is minted only when the first
 * message arrives.
 *
 * `draftKey` is what the client holds meanwhile, and it does three jobs:
 *   1. it is a non-null anchor, so a client that gates its outbound queue on
 *      "a conversation is attached" (mobile's `SendMessageUseCase.flushIfReady`)
 *      still drains on the first send;
 *   2. the client re-presents it as `session.configure.conversationId`, so a
 *      reconnect mid-draft stays on the SAME draft;
 *   3. it is the mint key — the idempotency key of §4.2. The ack below cannot
 *      join a SQLite transaction, so a commit whose `session.created` is lost
 *      is retried by the client against the same draft key and resolves to the
 *      session already minted, instead of forking a second one.
 *
 * It is NEVER a session id: `session.title`, `conversation.activate` and the
 * sessions REST surface all refuse it, and it never appears in the session list.
 */
export const sessionDraftSchema = z.object({
  type: z.literal("session.draft"),
  /** Echoed when this answers a `session.new`; absent on the handshake push. */
  requestId: z.string().min(1).optional(),
  draftKey: z.string().min(1),
  ts: z.number().int().nonnegative(),
});

/**
 * Gateway → client: this session's title changed.
 *
 * Distinct from `sessions.renamed`, which is the echo of a client's own rename
 * request: this frame is pushed to every attached window when the gateway
 * itself titles a session, and it carries the provenance so a client never
 * lets a generated title overwrite what a person typed.
 */
export const sessionTitleSchema = z.object({
  type: z.literal("session.title"),
  sessionId: z.string().min(1),
  title: z.string().max(TITLE_MAX),
  provenance: z.enum(["generated", "user"]),
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

export type SessionDraftEvent = z.infer<typeof sessionDraftSchema>;
export type SessionTitleEvent = z.infer<typeof sessionTitleSchema>;
export type SessionsDeletedEvent = z.infer<typeof sessionsDeletedEventSchema>;
export type SessionsRenamedEvent = z.infer<typeof sessionsRenamedEventSchema>;
export type SessionNewMessage = z.infer<typeof sessionNewSchema>;
export type SessionCreatedEvent = z.infer<typeof sessionCreatedEventSchema>;
export type SessionSwitchedEvent = z.infer<typeof sessionSwitchedEventSchema>;
export type SessionsErrorEvent = z.infer<typeof sessionsErrorSchema>;
