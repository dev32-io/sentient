import type { JSX } from "preact";
import type { ChatAttachment, ChatMessage } from "../../types.ts";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";
import { AttachmentCards, type AttachmentAsset } from "./attachment-cards.tsx";
import { MessageContent } from "./message-content.tsx";
import { MessageBubbleFrame } from "./message-frame.tsx";
import { ASSISTANT_NAME, AssistantMessageIdentity, MessageContinuationIdentity } from "./message-identity.tsx";
import { messageStateFor } from "./message-state.ts";

export interface AssistantMessageBubbleProps {
  message: ChatMessage;
  identityState: SentientIdentityState;
  continuation: boolean;
  position?: number | undefined;
  total?: number | undefined;
  attachmentAssets?: Readonly<Record<string, AttachmentAsset>> | undefined;
  onAttachmentPreview?: ((attachment: ChatAttachment) => void) | undefined;
}

export function AssistantMessageBubble({ message, identityState, continuation, position, total, attachmentAssets = {}, onAttachmentPreview }: AssistantMessageBubbleProps): JSX.Element {
  return (
    <MessageBubbleFrame
      message={message}
      name={ASSISTANT_NAME}
      identity={continuation ? <MessageContinuationIdentity /> : <AssistantMessageIdentity state={identityState} />}
      state={messageStateFor(message, identityState)}
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
