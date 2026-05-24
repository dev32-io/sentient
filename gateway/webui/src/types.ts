import type { ConversationAssistantCutoff, ConversationUserChannel } from "@sentient/protocol";
import type { TaskSnapshotItem } from "@sentient/web-sdk";
import type { AuthUser } from "./services/auth-api.js";

/** Chat message for UI rendering */
export interface ChatMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp: number;
  readonly isStreaming: boolean;
  /** Cycle that produced this assistant message, or triggered by this user message. */
  readonly cycleId?: string;
  /** Present for user messages only — which input channel the message came in on. */
  readonly channel?: ConversationUserChannel;
  /** Present for assistant messages that ended with a cutoff (barge-in or interrupt). */
  readonly cutoff?: ConversationAssistantCutoff;
  /** Assistant messages only: tasks grouped onto this message by shared cycleId. */
  readonly tools?: readonly TaskSnapshotItem[];
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
