import type { JSX } from "preact";
import { IconButton } from "../common/icon-button.tsx";

export interface TtsButtonProps {
  enabled: boolean;
  onToggle(): void;
}

export function TtsButton({ enabled, onToggle }: TtsButtonProps): JSX.Element {
  return (
    <IconButton
      iconName={enabled ? "volume-2" : "volume-x"}
      title={enabled ? "Mute assistant voice" : "Unmute assistant voice"}
      variant={enabled ? "tts-on" : "tts-off"}
      active={enabled}
      onClick={onToggle}
    />
  );
}
