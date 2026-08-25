import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
export interface SelectOption { value: string; label: string; icon?: JSX.Element; tag?: string; }
export interface SelectProps { value: string; onChange: (value: string) => void; options: SelectOption[]; placeholder?: string; disabled?: boolean; }
export function Select({ value, onChange, options, placeholder = "Select…", disabled }: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = options.find((option) => option.value === value);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent): void => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", dismiss); window.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={rootRef} class="snt-select-menu">
    <button type="button" class="snt-button snt-menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} disabled={disabled} onClick={() => setOpen((value) => !value)}>{current?.icon}<span>{current?.label ?? placeholder}</span><span aria-hidden="true">⌄</span></button>
    {open && <div id={menuId} class="snt-select-menu__options snt-float" role="menu">{options.map((option) => <button key={option.value} type="button" class="snt-button snt-button--quiet" aria-pressed={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.icon}<span>{option.label}</span>{option.tag && <span class="snt-kicker">{option.tag}</span>}</button>)}</div>}
  </div>;
}
