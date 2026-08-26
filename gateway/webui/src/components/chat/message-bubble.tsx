import type { JSX } from "preact";
import { MessageGroup, type MessageGroupProps } from "./message-group.tsx";

/** Public chat bubble entry point. Internal role/layout structure stays private. */
export type MessageBubbleProps = MessageGroupProps;
export type { CurrentUser } from "./message-identity.tsx";

export function MessageBubble(props: MessageBubbleProps): JSX.Element {
  return <MessageGroup {...props} />;
}
