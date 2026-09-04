import type { JSX } from "preact";

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
      <span class="dock-interrupt-button__glyph" aria-hidden="true" />
    </button>
  );
}
