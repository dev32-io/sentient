import type { ConversationAssistantCutoff, ConversationUserChannel } from "@sentient/protocol";
import type { ToolCallSnapshotItem } from "@sentient/web-sdk";
import type { AuthUser } from "./services/auth-api.js";

/** Chat message for UI rendering.
 *
 *  `trigger` is a feed entry nobody typed — a background task's result today,
 *  a sensor reading or a scheduled wake later. It is NOT a chat bubble and
 *  never renders as one (see `SystemEventRow`): attributing it to a person is
 *  the client half of defect D16. */
export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant" | "trigger";
  readonly text: string;
  readonly timestamp: number;
  readonly isStreaming: boolean;
  /** Turn that produced this assistant message, or triggered by this user message. */
  readonly turnId?: string;
  /** Present for user messages only — which input channel the message came in on. */
  readonly channel?: ConversationUserChannel;
  /** Present for assistant messages that ended with a cutoff (barge-in or interrupt). */
  readonly cutoff?: ConversationAssistantCutoff;
  /** Assistant messages only: tool calls grouped onto this message by shared turnId. */
  readonly tools?: readonly ToolCallSnapshotItem[];
  /** Trigger messages only: which stimulus source produced the entry, read
   *  straight off the wire item (`background-completion` today). */
  readonly source?: string;
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
