import type { JSX } from "preact";
import { Icon } from "../common/icon.tsx";
import { ActionButton } from "../common/foundation.tsx";

export interface NewChatButtonProps {
  onClick(event: MouseEvent): void;
  disabled?: boolean;
}

export function NewChatButton({ onClick, disabled }: NewChatButtonProps): JSX.Element {
  return (
    <ActionButton className="new-chat-button" variant="primary" disabled={disabled} onClick={onClick}>
      <span aria-hidden="true"><Icon name="plus" size={18} /></span>
      <span>New chat</span>
    </ActionButton>
  );
}
