import type { JSX } from "preact";
import { Icon } from "../common/icon.tsx";
import { ActionButton } from "../common/foundation.tsx";

export interface NewChatButtonProps {
  onClick(): void;
}

export function NewChatButton({ onClick }: NewChatButtonProps): JSX.Element {
  return (
    <ActionButton className="new-chat-button" variant="primary" onClick={onClick}>
      <span class="new-chat-button__plus" aria-hidden="true">
        <Icon name="plus" size={14} />
      </span>
      <span>New chat</span>
    </ActionButton>
  );
}
