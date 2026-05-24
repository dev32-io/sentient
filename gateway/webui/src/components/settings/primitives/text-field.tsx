// gateway/webui/src/components/settings/primitives/text-field.tsx
import type { JSX } from "preact";

export interface TextFieldProps {
  value: string;
  onChange: (e: Event) => void;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  type?: "text" | "password" | "email" | "tel";
  monospace?: boolean;
  fullWidth?: boolean;
  error?: boolean;
  disabled?: boolean;
}

export function TextField({
  value,
  onChange,
  placeholder,
  prefix,
  suffix,
  type = "text",
  monospace,
  fullWidth,
  error,
  disabled,
}: TextFieldProps): JSX.Element {
  const cls = ["tf", monospace ? "mono" : "", fullWidth ? "full" : "", error ? "err" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div class={cls}>
      {prefix && <span class="tf-pre">{prefix}</span>}
      <input
        type={type}
        value={value ?? ""}
        onInput={onChange}
        placeholder={placeholder}
        disabled={disabled}
      />
      {suffix && <span class="tf-suf">{suffix}</span>}
    </div>
  );
}
