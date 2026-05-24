import type { JSX } from "preact";
import { Icon } from "../common/icon.tsx";

export interface SendButtonProps {
  disabled: boolean;
  onSend(): void;
}

export function SendButton({ disabled, onSend }: SendButtonProps): JSX.Element {
  return (
    <button
      type="button"
      class="send-btn"
      aria-label="Send"
      disabled={disabled}
      onClick={onSend}
    >
      <Icon name="send" size={16} />
    </button>
  );
}
