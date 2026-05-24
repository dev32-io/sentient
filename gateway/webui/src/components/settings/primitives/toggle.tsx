import type { JSX } from "preact";

export interface ToggleProps {
  on: boolean;
  onChange: () => void;
  disabled?: boolean;
}

export function Toggle({ on, onChange, disabled }: ToggleProps): JSX.Element {
  return (
    <button
      type="button"
      class={["tg", on && "on"].filter(Boolean).join(" ")}
      onClick={onChange}
      aria-pressed={on}
      disabled={disabled}
    >
      <span class="tg-knob" />
    </button>
  );
}
