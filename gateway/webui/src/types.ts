import type { ConversationAssistantCutoff, ConversationUserChannel } from "@sentient/protocol";
import type { ToolCallSnapshotItem } from "@sentient/web-sdk";
import type { AuthUser } from "./services/auth-api.js";

/** Chat message for UI rendering.
 *
 *  Only what a person said and what the assistant answered. A stimulus nobody
 *  typed — a background task's result today, a sensor reading or a scheduled
 *  wake later — never becomes one of these: it is context the model answers
 *  FROM, and the answer is the artifact (owner, 2026-07-31). See the `trigger`
 *  arm of `cycle-helpers.ts`'s feed walk. */
export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
  readonly isStreaming: boolean;
  /** Turn that produced this assistant message, or triggered by this user message. */
  readonly turnId?: string;
  /** WHICH BUBBLE this message is. Several committed rows of one ReAct turn
   *  share it and merge into the single bubble the stream showed. */
  readonly messageId?: string;
  /** Present for user messages only — which input channel the message came in on. */
  readonly channel?: ConversationUserChannel;
  /** Present for assistant messages that ended with a cutoff (barge-in or interrupt). */
  readonly cutoff?: ConversationAssistantCutoff;
  /** Assistant messages only: tool calls grouped onto this message by shared turnId. */
  readonly tools?: readonly ToolCallSnapshotItem[];
}

/** Auth state */
export type AuthState =
  | { status: "boot" }
  | { status: "anonymous" }
  | { status: "authenticating" }
  | { status: "authenticated"; token: string; user: AuthUser }
  | { status: "failed"; reason: string };

export function createChatMessage(
  role: "user" | "assistant",
  text: string,
  overrides: Partial<Pick<ChatMessage, "id" | "isStreaming">> = {},
): ChatMessage {
  return {
    id: overrides.id ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    timestamp: Date.now(),
    isStreaming: overrides.isStreaming ?? false,
  };
}
