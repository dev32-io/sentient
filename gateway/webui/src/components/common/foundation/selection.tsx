import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { classes } from "./utils.ts";

export interface CheckboxControlProps {
  label: ComponentChildren;
  checked: boolean;
  indeterminate?: boolean | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  onChange: (checked: boolean) => void;
}

export function CheckboxControl({ label, checked, indeterminate, disabled, className, onChange }: CheckboxControlProps): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  return (
    <label class={classes("snt-checkbox", className)}>
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span class="snt-checkbox__box" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
