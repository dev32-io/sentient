import type { JSX } from "preact";

export interface InterruptButtonProps {
  onInterrupt(): void;
}

export function InterruptButton({ onInterrupt }: InterruptButtonProps): JSX.Element {
  return (
    <button
      type="button"
      class="interrupt-btn"
      aria-label="Interrupt"
      onClick={onInterrupt}
    >
      <span class="interrupt-btn__glyph" aria-hidden="true" />
    </button>
  );
}
