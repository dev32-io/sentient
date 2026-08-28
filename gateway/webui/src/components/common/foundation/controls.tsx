import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";

export interface SliderControlProps {
  label?: string | undefined;
  value: number;
  min: number;
  max: number;
  step?: number | undefined;
  disabled?: boolean | undefined;
  format?: (value: number) => string | undefined;
  onChange: (value: number) => void;
}

export function SliderControl({ label, value, min, max, step = 1, disabled, format = String, onChange }: SliderControlProps): JSX.Element {
  const progress = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <label class="snt-field">
      {label && <span class="snt-field__label">{label}</span>}
      <span class="snt-range-row">
        <input class="snt-range" style={{ "--snt-range-progress": `${progress}%` }} type="range" value={value} min={min} max={max} step={step} disabled={disabled} onInput={(event) => onChange(Number(event.currentTarget.value))} />
        <output>{format(value)}</output>
      </span>
    </label>
  );
}

export interface ToggleControlProps {
  label: string;
  checked: boolean;
  disabled?: boolean | undefined;
  onChange: (checked: boolean) => void;
}

export function ToggleControl({ label, checked, disabled, onChange }: ToggleControlProps): JSX.Element {
  return <button type="button" role="switch" class="snt-toggle" aria-label={label} aria-checked={checked} aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export interface SegmentedOption {
  value: string;
  label: string;
  disabled?: boolean | undefined;
}

export interface SegmentedControlProps {
  label: string;
  value: string;
  options: readonly SegmentedOption[];
  disabled?: boolean | undefined;
  onChange: (value: string) => void;
}

export function SegmentedControl({ label, value, options, disabled, onChange }: SegmentedControlProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const position = (): void => {
      const active = root.querySelector<HTMLElement>("[aria-pressed='true']");
      if (!active) return;
      root.style.setProperty("--snt-segment-width", `${active.offsetWidth}px`);
      root.style.setProperty("--snt-segment-x", `${active.offsetLeft}px`);
      root.dataset.sntReady = "true";
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(root);
    return () => observer?.disconnect();
  }, [value, options]);
  return (
    <div ref={rootRef} class="snt-segmented" role="group" aria-label={label}>
      {options.map((option) => <button key={option.value} type="button" class="snt-segment" aria-pressed={option.value === value} disabled={disabled || option.disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  );
}

export interface ChipControlProps {
  children: ComponentChildren;
  selected?: boolean | undefined;
  disabled?: boolean | undefined;
  onClick?: () => void | undefined;
}

export function ChipControl({ children, selected = false, disabled, onClick }: ChipControlProps): JSX.Element {
  return <button type="button" class="snt-chip" aria-pressed={selected} disabled={disabled} onClick={onClick}>{children}</button>;
}

export interface CheckboxControlProps {
  label: ComponentChildren;
  checked: boolean;
  indeterminate?: boolean | undefined;
  disabled?: boolean | undefined;
  onChange: (checked: boolean) => void;
}

export function CheckboxControl({ label, checked, indeterminate, disabled, onChange }: CheckboxControlProps): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = Boolean(indeterminate); }, [indeterminate]);
  return (
    <label class="snt-checkbox">
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span class="snt-checkbox__box" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}

export interface ProgressControlProps {
  label: string;
  value?: number | undefined;
  max?: number | undefined;
}

export function ProgressControl({ label, value, max = 100 }: ProgressControlProps): JSX.Element {
  return <progress class="snt-progress" aria-label={label} max={max} value={value} />;
}

export function Divider(): JSX.Element {
  return <hr class="snt-divider" />;
}
