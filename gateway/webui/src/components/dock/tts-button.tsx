import type { JSX } from "preact";
import { ComposerGlyph } from "./composer-glyph.tsx";

export interface TtsButtonProps {
  enabled: boolean;
  onToggle(): void;
}

export function TtsButton({ enabled, onToggle }: TtsButtonProps): JSX.Element {
  const label = enabled ? "Mute assistant voice" : "Unmute assistant voice";
  return (
    <button
      type="button"
      class={`dock-composer-control dock-composer__tts${enabled ? " dock-composer__tts--enabled" : ""}`}
      aria-label={label}
      aria-pressed={enabled}
      title={label}
      onClick={onToggle}
    >
      <ComposerGlyph name={enabled ? "volume" : "volume-off"} />
    </button>
  );
}
