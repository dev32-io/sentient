import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface SurfaceProps {
  children: ComponentChildren;
  className?: string | undefined;
}

export function Surface({ children, className }: SurfaceProps): JSX.Element {
  return <div class={classes("snt-surface", className)}>{children}</div>;
}

export function Plate({ children, className }: SurfaceProps): JSX.Element {
  return <section class={classes("snt-plate", className)}>{children}</section>;
}

export function Well({ children, className }: SurfaceProps): JSX.Element {
  return <div class={classes("snt-well", className)}>{children}</div>;
}

export interface ActionButtonProps {
  children: ComponentChildren;
  variant?: "default" | "primary" | "quiet" | "destructive" | undefined;
  type?: "button" | "submit" | "reset" | undefined;
  disabled?: boolean | undefined;
  loading?: boolean | undefined;
  className?: string | undefined;
  title?: string | undefined;
  role?: JSX.HTMLAttributes<HTMLButtonElement>["role"] | undefined;
  ariaLabel?: string | undefined;
  buttonRef?: { current: HTMLButtonElement | null } | undefined;
  expanded?: boolean | undefined;
  hasPopup?: "menu" | "dialog" | boolean | undefined;
  "aria-expanded"?: boolean | undefined;
  "aria-controls"?: string | undefined;
  "aria-pressed"?: boolean | undefined;
  onClick?: (event: MouseEvent) => void | undefined;
}

export function ActionButton({ children, variant = "default", type = "button", disabled, loading, className, title, role, ariaLabel, buttonRef, expanded, hasPopup, "aria-expanded": ariaExpanded, "aria-controls": ariaControls, "aria-pressed": ariaPressed, onClick }: ActionButtonProps): JSX.Element {
  return (
    <button
      {...(buttonRef ? { ref: buttonRef } : {})}
      type={type}
      class={classes("snt-button", variant !== "default" && `snt-button--${variant}`, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      title={title}
      role={role}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded ?? expanded}
      aria-controls={ariaControls}
      aria-pressed={ariaPressed}
      aria-haspopup={hasPopup}
      onClick={onClick}
    >
      {loading && <span class="snt-button__spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface FoundationIconButtonProps extends Omit<ActionButtonProps, "children" | "variant" | "loading" | "ariaLabel"> {
  label: string;
  children: ComponentChildren;
  variant?: "default" | "quiet" | "destructive" | undefined;
  pressed?: boolean | undefined;
}

export function FoundationIconButton({ label, children, variant = "default", pressed, className, buttonRef, expanded, hasPopup, ...props }: FoundationIconButtonProps): JSX.Element {
  return (
    <button
      {...props}
      {...(buttonRef ? { ref: buttonRef } : {})}
      type="button"
      class={classes("snt-icon-button", variant !== "default" && `snt-button--${variant}`, className)}
      aria-label={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-haspopup={hasPopup}
      title={props.title ?? label}
    >
      {children}
    </button>
  );
}

interface FieldShellProps {
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  invalid?: boolean | undefined;
  id?: string | undefined;
  children: (ids: { id: string; describedBy?: string | undefined }) => ComponentChildren;
  className?: string | undefined;
}

function FieldShell({ label, hint, error, invalid = false, id: suppliedId, children, className }: FieldShellProps): JSX.Element {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div class={classes("snt-field", className)} data-error={error || invalid ? "true" : undefined}>
      {label && <label class="snt-field__label" for={id}>{label}</label>}
      {children({ id, describedBy })}
      {hint && <span class="snt-field__hint" id={hintId}>{hint}</span>}
      {error && <span class="snt-field__error" id={errorId}>{error}</span>}
    </div>
  );
}

export interface FieldProps {
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  id?: string | undefined;
  value?: string | undefined;
  defaultValue?: string | undefined;
  placeholder?: string | undefined;
  type?: "text" | "password" | "email" | "tel" | "search" | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  autoComplete?: string | undefined;
  inputMode?: JSX.HTMLAttributes<HTMLInputElement>["inputMode"] | undefined;
  maxLength?: number | undefined;
  pattern?: string | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
  inputClassName?: string | undefined;
  inputRef?: { current: HTMLInputElement | null } | undefined;
  ariaLabel?: string | undefined;
  onInput?: (event: JSX.TargetedEvent<HTMLInputElement, InputEvent>) => void | undefined;
  onChange?: (event: JSX.TargetedEvent<HTMLInputElement, Event>) => void | undefined;
  onKeyDown?: (event: JSX.TargetedKeyboardEvent<HTMLInputElement>) => void | undefined;
}

export function Field({ label, hint, error, id, className, inputClassName, inputRef, ariaLabel, ...input }: FieldProps): JSX.Element {
  return (
    <FieldShell label={label} hint={hint} error={error} id={id} className={className}>
      {({ id: inputId, describedBy }) => <input {...input} {...(inputRef ? { ref: inputRef } : {})} id={inputId} aria-label={ariaLabel} aria-describedby={describedBy} class={classes("snt-input", inputClassName)} aria-invalid={Boolean(error) || undefined} />}
    </FieldShell>
  );
}

export interface TextFieldProps extends Omit<FieldProps, "inputClassName" | "inputRef"> {
  prefix?: ComponentChildren | undefined;
  suffix?: ComponentChildren | undefined;
  monospace?: boolean | undefined;
  fullWidth?: boolean | undefined;
  invalid?: boolean | undefined;
  inputClassName?: string | undefined;
  inputRef?: { current: HTMLInputElement | null } | undefined;
}

/** A field with optional inline adornments; settings wrappers delegate here. */
export function TextField({ prefix, suffix, monospace = false, fullWidth = false, invalid = false, label, hint, error, id, className, inputClassName, inputRef, ariaLabel, ...input }: TextFieldProps): JSX.Element {
  return (
    <FieldShell label={label} hint={hint} error={error} invalid={invalid} id={id} className={classes(className, fullWidth && "snt-field--full")}>
      {({ id: inputId, describedBy }) => (
        <span class={classes("snt-input-group", monospace && "snt-input-group--mono")}>
          {prefix && <span class="snt-input-group__prefix">{prefix}</span>}
          <input {...input} {...(inputRef ? { ref: inputRef } : {})} id={inputId} aria-label={ariaLabel} aria-describedby={describedBy} class={classes("snt-input-group__input", inputClassName)} aria-invalid={Boolean(error) || invalid || undefined} />
          {suffix && <span class="snt-input-group__suffix">{suffix}</span>}
        </span>
      )}
    </FieldShell>
  );
}

export interface TextAreaProps {
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  id?: string | undefined;
  value?: string | undefined;
  placeholder?: string | undefined;
  rows?: number | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  maxLength?: number | undefined;
  spellcheck?: boolean | undefined;
  className?: string | undefined;
  inputClassName?: string | undefined;
  monospace?: boolean | undefined;
  dirty?: boolean | undefined;
  onInput?: (event: JSX.TargetedEvent<HTMLTextAreaElement, InputEvent>) => void | undefined;
}

export function TextArea({ label, hint, error, id, className, inputClassName, monospace = false, dirty = false, ...input }: TextAreaProps): JSX.Element {
  return (
    <FieldShell label={label} hint={hint} error={error} id={id} className={className}>
      {({ id: inputId, describedBy }) => <textarea {...input} id={inputId} aria-describedby={describedBy} class={classes("snt-textarea", monospace && "snt-textarea--mono", dirty && "snt-textarea--dirty", inputClassName)} data-dirty={dirty || undefined} aria-invalid={Boolean(error) || undefined} />}
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean | undefined;
  icon?: JSX.Element | undefined;
  tag?: string | undefined;
}

export interface SelectControlProps {
  label?: string | undefined;
  hint?: string | undefined;
  error?: string | undefined;
  id?: string | undefined;
  value?: string | undefined;
  options: readonly SelectOption[];
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  required?: boolean | undefined;
  className?: string | undefined;
  onChange: (value: string) => void;
}

export function SelectControl({ label, hint, error, id, value, options, placeholder, disabled, required, className, onChange }: SelectControlProps): JSX.Element {
  return (
    <FieldShell label={label} hint={hint} error={error} id={id} className={className}>
      {({ id: inputId, describedBy }) => (
        <div class="snt-select-wrap">
          <select
            id={inputId}
            aria-describedby={describedBy}
            class="snt-select"
            value={value}
            disabled={disabled}
            required={required}
            aria-invalid={Boolean(error) || undefined}
            onChange={(event) => onChange(event.currentTarget.value)}
          >
            {placeholder && <option value="" disabled>{placeholder}</option>}
            {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}{option.tag ? ` — ${option.tag}` : ""}</option>)}
          </select>
        </div>
      )}
    </FieldShell>
  );
}

export interface MenuTriggerProps {
  label: string;
  expanded: boolean;
  controls: string;
  disabled?: boolean | undefined;
  onClick: () => void;
}

export function MenuTrigger({ label, expanded, controls, disabled, onClick }: MenuTriggerProps): JSX.Element {
  return <button type="button" class="snt-button snt-menu-trigger" aria-haspopup="menu" aria-expanded={expanded} aria-controls={controls} disabled={disabled} onClick={onClick}><span>{label}</span><span aria-hidden="true">⌄</span></button>;
}

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
