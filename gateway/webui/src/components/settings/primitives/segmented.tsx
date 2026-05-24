import type { JSX } from "preact";

export interface SegmentedOption {
  value: string;
  label: string;
}

export interface SegmentedProps {
  value: string;
  onChange: (v: string) => void;
  options: SegmentedOption[];
  disabled?: boolean;
}

export function Segmented({ value, onChange, options, disabled }: SegmentedProps): JSX.Element {
  return (
    <div class="seg2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          class={value === o.value ? "on" : undefined}
          onClick={() => onChange(o.value)}
          disabled={disabled}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
