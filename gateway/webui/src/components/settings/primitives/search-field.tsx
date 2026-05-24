import type { JSX } from "preact";

export interface SearchFieldProps {
  value: string;
  onChange: (e: Event) => void;
  placeholder?: string;
  fullWidth?: boolean;
}

export function SearchField({ value, onChange, placeholder, fullWidth }: SearchFieldProps): JSX.Element {
  return (
    <div class={["srch", fullWidth && "full"].filter(Boolean).join(" ")}>
      <span class="srch-icon" aria-hidden="true">⌕</span>
      <input value={value} onInput={onChange} placeholder={placeholder} />
    </div>
  );
}
