import type { JSX } from "preact";
import type { ChatMessage } from "../../types.ts";
import type { SentientIdentityState } from "../common/sentient-identity.tsx";
import { MessageContent } from "./message-content.tsx";
import { MessageBubbleFrame } from "./message-frame.tsx";
import { ASSISTANT_NAME, AssistantMessageIdentity, MessageContinuationIdentity } from "./message-identity.tsx";
import { messageStateFor } from "./message-state.ts";
import { SpeakingWave } from "./streaming-presentation.tsx";

export interface AssistantMessageBubbleProps {
  message: ChatMessage;
  identityState: SentientIdentityState;
  continuation: boolean;
  position?: number | undefined;
  total?: number | undefined;
}

export function AssistantMessageBubble({ message, identityState, continuation, position, total }: AssistantMessageBubbleProps): JSX.Element {
  return (
    <MessageBubbleFrame
      message={message}
      name={ASSISTANT_NAME}
      identity={continuation ? <MessageContinuationIdentity /> : <AssistantMessageIdentity state={identityState} />}
      state={messageStateFor(message, identityState)}
      continuation={continuation}
      position={position}
      total={total}
      surfaceEffect={<SpeakingWave active={identityState === "responding"} />}
      content={<MessageContent text={message.text} isStreaming={message.isStreaming} cutoff={message.cutoff} />}
    />
  );
}
