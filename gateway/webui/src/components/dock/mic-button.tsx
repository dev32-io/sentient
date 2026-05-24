import type { JSX } from "preact";
import { IconButton } from "../common/icon-button.tsx";

export interface MicButtonProps {
  active: boolean;
  onToggle(): void;
}

export function MicButton({ active, onToggle }: MicButtonProps): JSX.Element {
  return (
    <IconButton
      iconName={active ? "mic" : "mic-off"}
      title={active ? "Mute microphone" : "Enable microphone"}
      variant={active ? "mic-on" : "mic-off"}
      active={active}
      onClick={onToggle}
    />
  );
}
