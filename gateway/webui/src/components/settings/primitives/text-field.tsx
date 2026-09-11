import type { JSX } from "preact";
import { TextField as FoundationTextField } from "../../common/foundation.tsx";

export interface TextFieldProps {
  value: string;
  onChange: (event: Event) => void;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  type?: "text" | "password" | "email" | "tel";
  monospace?: boolean;
  fullWidth?: boolean;
  error?: boolean;
  disabled?: boolean;
}

/** Compatibility wrapper; adornments and input semantics live in the common field. */
export function TextField({ value, onChange, placeholder, prefix, suffix, type = "text", monospace, fullWidth, error, disabled }: TextFieldProps): JSX.Element {
  return (
    <FoundationTextField
      value={value ?? ""}
      onInput={(event) => onChange(event as unknown as Event)}
      placeholder={placeholder}
      prefix={prefix}
      suffix={suffix}
      type={type}
      monospace={monospace}
      fullWidth={fullWidth}
      invalid={error}
      disabled={disabled}
    />
  );
}
