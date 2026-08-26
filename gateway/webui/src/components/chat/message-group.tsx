import type { JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";
import { AssistantMessageBubble } from "./assistant-message-bubble.tsx";
import { UserMessageBubble } from "./user-message-bubble.tsx";
import type { CurrentUser } from "./message-identity.tsx";

export interface MessageGroupProps {
  message: ChatMessage;
  identityState: SentientIdentityState;
  currentUser: CurrentUser;
  continuation?: boolean | undefined;
  position?: number | undefined;
  total?: number | undefined;
}

/** Chooses the role-owned bubble while keeping continuation in chronology. */
export function MessageGroup({ message, identityState, currentUser, continuation = false, position, total }: MessageGroupProps): JSX.Element {
  if (message.role === "user") {
    return <UserMessageBubble message={message} currentUser={currentUser} continuation={continuation} position={position} total={total} />;
  }
  return <AssistantMessageBubble message={message} identityState={identityState} continuation={continuation} position={position} total={total} />;
}
