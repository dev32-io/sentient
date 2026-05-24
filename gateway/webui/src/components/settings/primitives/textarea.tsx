// gateway/webui/src/components/settings/primitives/textarea.tsx
import type { JSX } from "preact";

export interface TextareaProps {
  value: string;
  onChange: (e: Event) => void;
  placeholder?: string;
  rows?: number;
  monospace?: boolean;
  dirty?: boolean;
  disabled?: boolean;
  spellcheck?: boolean;
  /** Hard cap on input length (browser-enforced). The browser refuses keystrokes
   *  past this — paste is clamped automatically. */
  maxLength?: number;
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 4,
  monospace,
  dirty,
  disabled,
  spellcheck,
  maxLength,
}: TextareaProps): JSX.Element {
  const cls = ["ta", monospace ? "mono" : "", dirty ? "dirty" : ""].filter(Boolean).join(" ");
  return (
    <textarea
      class={cls}
      rows={rows}
      value={value ?? ""}
      onInput={onChange}
      placeholder={placeholder}
      disabled={disabled}
      spellcheck={spellcheck}
      maxLength={maxLength}
    />
  );
}
