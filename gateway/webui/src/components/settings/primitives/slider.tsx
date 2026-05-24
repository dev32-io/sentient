import type { JSX } from "preact";

export interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  disabled?: boolean;
}

export function Slider({ value, onChange, min, max, step, format, disabled }: SliderProps): JSX.Element {
  return (
    <div class="sld">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={(e) => onChange(parseFloat((e.target as HTMLInputElement).value))}
        disabled={disabled}
      />
      <span class="sld-v">{format ? format(value) : String(value)}</span>
    </div>
  );
}
