import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ChevronIcon } from "../../common/icons/chevron.tsx";
import { CheckIcon } from "../../common/icons/check.tsx";

export interface SelectOption {
  value: string;
  label: string;
  icon?: JSX.Element;
  tag?: string;
}

export interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
}

export function Select({ value, onChange, options, placeholder, disabled }: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);

  const cur = options.find((o) => o.value === value);

  return (
    <div class={["sel", open && "open"].filter(Boolean).join(" ")} ref={ref}>
      <button
        type="button"
        class="sel-btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
      >
        {cur ? (
          <span class="sel-cur">
            {cur.icon}
            <span class="sel-l">{cur.label}</span>
            {cur.tag && <span class="sel-tag">{cur.tag}</span>}
          </span>
        ) : (
          <span class="sel-ph">{placeholder ?? "Select…"}</span>
        )}
        <ChevronIcon size={12} />
      </button>
      {open && (
        <div class="sel-menu">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              class={["sel-opt", o.value === value && "on"].filter(Boolean).join(" ")}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.icon}
              <span class="sel-l">{o.label}</span>
              {o.tag && <span class="sel-tag">{o.tag}</span>}
              {o.value === value && <CheckIcon size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
