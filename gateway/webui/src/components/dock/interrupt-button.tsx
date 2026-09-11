import type { JSX } from "preact";
import { ComposerGlyph } from "./composer-glyph.tsx";

export interface InterruptButtonProps {
  onInterrupt(): void;
}

export function InterruptButton({ onInterrupt }: InterruptButtonProps): JSX.Element {
  return (
    <button
      type="button"
      class="dock-composer-control dock-composer-control--stop dock-interrupt-button"
      aria-label="Interrupt"
      title="Interrupt"
      onClick={onInterrupt}
    >
      <ComposerGlyph name="stop" />
    </button>
  );
}
