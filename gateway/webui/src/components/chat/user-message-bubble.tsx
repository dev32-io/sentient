import type { JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import { MessageContent } from "./message-content.tsx";
import { MessageBubbleFrame } from "./message-frame.tsx";
import { MessageContinuationIdentity, UserMessageIdentity, type CurrentUser } from "./message-identity.tsx";

export interface UserMessageBubbleProps {
  message: ChatMessage;
  currentUser: CurrentUser;
  continuation: boolean;
  position?: number | undefined;
  total?: number | undefined;
}

export function UserMessageBubble({ message, currentUser, continuation, position, total }: UserMessageBubbleProps): JSX.Element {
  return (
    <MessageBubbleFrame
      message={message}
      name={currentUser.displayName}
      identity={continuation ? <MessageContinuationIdentity /> : <UserMessageIdentity currentUser={currentUser} />}
      continuation={continuation}
      position={position}
      total={total}
      content={<MessageContent text={message.text} isStreaming={message.isStreaming} cutoff={message.cutoff} />}
    />
  );
}
