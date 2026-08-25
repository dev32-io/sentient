import type { JSX } from "preact";
export interface TextFieldProps { value: string; onChange: (event: Event) => void; placeholder?: string; prefix?: string; suffix?: string; type?: "text" | "password" | "email" | "tel"; monospace?: boolean; fullWidth?: boolean; error?: boolean; disabled?: boolean; }
export function TextField({ value, onChange, placeholder, prefix, suffix, type = "text", monospace, fullWidth, error, disabled }: TextFieldProps): JSX.Element {
  return <div class={`snt-filter-bar${fullWidth ? " full" : ""}`} data-error={error ? "true" : undefined}>{prefix && <span class="snt-kicker">{prefix}</span>}<input class={`snt-input${monospace ? " mono" : ""}`} type={type} value={value ?? ""} onInput={(event) => onChange(event)} placeholder={placeholder} aria-invalid={error || undefined} disabled={disabled} />{suffix && <span class="snt-kicker">{suffix}</span>}</div>;
}
