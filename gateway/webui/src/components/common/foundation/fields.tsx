import type { ComponentChildren, JSX } from "preact";
import { useId } from "preact/hooks";
import { classes } from "./utils.ts";

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
