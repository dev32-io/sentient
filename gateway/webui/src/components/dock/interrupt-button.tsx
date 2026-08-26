import type { JSX } from "preact";
import { FoundationIconButton } from "../common/foundation.tsx";

export interface InterruptButtonProps {
  onInterrupt(): void;
}

export function InterruptButton({ onInterrupt }: InterruptButtonProps): JSX.Element {
  return (
    <FoundationIconButton
      className="dock-interrupt-button"
      variant="destructive"
      label="Interrupt"
      onClick={onInterrupt}
    >
      <span class="dock-interrupt-button__glyph" aria-hidden="true" />
    </FoundationIconButton>
  );
}
