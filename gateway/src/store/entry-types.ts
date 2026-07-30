// The canonical session entry (spec §3.1).
//
// ONE schema feeds BOTH projections (model → OpenAI messages, client → feed).
// That is what makes projection convergence provable: there is no second
// record that can drift. Entries are append-only; nothing here is ever updated.

import { z } from "zod";

export type EntryKind = "user" | "assistant" | "tool_call" | "tool_result" | "trigger" | "system" | "compaction";

/** Why an assistant entry stopped early. Null unless the turn was cut off. */
export type CutoffKind = "interrupt" | "barge-in";

export interface SessionEntry {
  /**
   * Store-wide monotonic sequence, assigned on append. Shared across every
   * session in this user's database — NOT restarted per session — so it orders
   * a session's entries without being a per-session counter.
   */
  seq: number;
  sessionId: string;
  /** Groups entries belonging to one turn (one ReAct loop run). */
  turnId: string;
  kind: EntryKind;
  /** Epoch millis, assigned by the store. Gateway-owned — Hermes had none. */
  createdAt: number;
  /** Message text for user/assistant/trigger/system/compaction; null otherwise. */
  text: string | null;
  /** Correlates a tool_call with its tool_result. Null for other kinds. */
  toolCallId: string | null;
  toolName: string | null;
  /** JSON-encoded arguments on tool_call; JSON-encoded result on tool_result. */
  toolArgs: string | null;
  cutoff: CutoffKind | null;
  /** On a compaction entry: the highest seq the summary covers. */
  compactedThroughSeq: number | null;
  /**
   * The client's own id for this message, on a `user` entry that arrived with
   * one; null everywhere else. Two jobs, both of which need it DURABLE rather
   * than held in a process-lifetime set: it makes a resend idempotent (the
   * store already knows this message was committed), and it is echoed back on
   * the committed feed so the client can drop its optimistic bubble.
   */
  pendingId: string | null;
}

export type NewSessionEntry = Omit<SessionEntry, "seq">;

export const sessionEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  kind: z.enum(["user", "assistant", "tool_call", "tool_result", "trigger", "system", "compaction"]),
  createdAt: z.number().int().nonnegative(),
  text: z.string().nullable(),
  toolCallId: z.string().nullable(),
  toolName: z.string().nullable(),
  toolArgs: z.string().nullable(),
  cutoff: z.enum(["interrupt", "barge-in"]).nullable(),
  compactedThroughSeq: z.number().int().nonnegative().nullable(),
  pendingId: z.string().nullable(),
});
