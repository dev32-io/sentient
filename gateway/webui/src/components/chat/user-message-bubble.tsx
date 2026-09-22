import type { JSX } from "preact";
import type { ChatAttachment, ChatMessage } from "../../types.ts";
import { AttachmentCards, type AttachmentAsset } from "./attachment-cards.tsx";
import { MessageContent } from "./message-content.tsx";
import { MessageBubbleFrame } from "./message-frame.tsx";
import { MessageContinuationIdentity, UserMessageIdentity, type CurrentUser } from "./message-identity.tsx";

export interface UserMessageBubbleProps {
  message: ChatMessage;
  currentUser: CurrentUser;
  continuation: boolean;
  position?: number | undefined;
  total?: number | undefined;
  attachmentAssets?: Readonly<Record<string, AttachmentAsset>> | undefined;
  onAttachmentPreview?: ((attachment: ChatAttachment) => void) | undefined;
}

export function UserMessageBubble({ message, currentUser, continuation, position, total, attachmentAssets = {}, onAttachmentPreview }: UserMessageBubbleProps): JSX.Element {
  return (
    <MessageBubbleFrame
      message={message}
      name={currentUser.displayName}
      identity={continuation ? <MessageContinuationIdentity /> : <UserMessageIdentity currentUser={currentUser} />}
      continuation={continuation}
      position={position}
      total={total}
      content={
        <>
          {message.attachments?.length ? <AttachmentCards attachments={message.attachments} assets={attachmentAssets} onPreview={onAttachmentPreview} /> : null}
          <MessageContent text={message.text} isStreaming={message.isStreaming} cutoff={message.cutoff} />
        </>
      }
    />
  );
}
