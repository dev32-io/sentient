import type { ComponentChildren, JSX } from "preact";
import {
  CheckboxControl,
  Field,
  SelectControl,
  TextArea,
  type FieldProps,
  type SelectOption,
  type TextAreaProps,
} from "../common/index.ts";

export type CalendarInputType = NonNullable<FieldProps["type"]> | "date" | "datetime-local" | "number";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/** Named Calendar field seam: native inputs stay behind this adapter. */
export interface CalendarTextFieldProps extends Omit<FieldProps, "type" | "className" | "inputClassName"> {
  readonly type?: CalendarInputType;
  readonly className?: string;
  readonly inputClassName?: string;
}

export function CalendarTextField({ type = "text", className, inputClassName, ...props }: CalendarTextFieldProps): JSX.Element {
  return (
    <Field
      {...props}
      type={type as FieldProps["type"]}
      className={classes("calendar-field", className)}
      inputClassName={classes("app-dialog__input", inputClassName)}
    />
  );
}

export interface CalendarTextAreaProps extends Omit<TextAreaProps, "className" | "inputClassName"> {
  readonly className?: string;
  readonly inputClassName?: string;
}

export function CalendarTextArea({ className, inputClassName, ...props }: CalendarTextAreaProps): JSX.Element {
  return (
    <TextArea
      {...props}
      className={classes("calendar-field", className)}
      inputClassName={classes("app-dialog__input", inputClassName)}
    />
  );
}

export interface CalendarSelectFieldProps {
  readonly label?: string;
  readonly hint?: string;
  readonly error?: string;
  readonly id?: string;
  readonly value?: string;
  readonly options: readonly SelectOption[];
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly className?: string;
  readonly onChange: (value: string) => void;
}

export function CalendarSelectField({ className, ...props }: CalendarSelectFieldProps): JSX.Element {
  return <SelectControl {...props} className={classes("calendar-field", className)} />;
}

export interface CalendarCheckboxFieldProps {
  readonly label: ComponentChildren;
  readonly checked: boolean;
  readonly indeterminate?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly onChange: (checked: boolean) => void;
}

export function CalendarCheckboxField({ className, ...props }: CalendarCheckboxFieldProps): JSX.Element {
  return <div class={classes("calendar-checkbox-field", className)}><CheckboxControl {...props} /></div>;
}

export interface CalendarReadOnlyFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: ComponentChildren;
  readonly className?: string;
}

export function CalendarReadOnlyField({ id, label, value, className }: CalendarReadOnlyFieldProps): JSX.Element {
  return (
    <div class={classes("calendar-field", className)}>
      <span class="snt-field__label">{label}</span>
      <output id={id} class="app-dialog__input calendar-editor__readonly" aria-readonly="true">{value}</output>
    </div>
  );
}
