import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";

export interface SelectOption { value: string; label: string; icon?: JSX.Element; tag?: string; }
export interface SelectProps { value: string; onChange: (value: string) => void; options: SelectOption[]; placeholder?: string; disabled?: boolean; }

export function Select({ value, onChange, options, placeholder = "Select…", disabled }: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const menuId = useId();
  const currentIndex = options.findIndex((option) => option.value === value);
  const current = currentIndex >= 0 ? options[currentIndex] : undefined;

  const focusOption = (index: number): void => {
    if (options.length === 0) return;
    const wrapped = (index + options.length) % options.length;
    optionRefs.current[wrapped]?.focus();
  };
  const openAt = (index: number): void => {
    if (disabled || options.length === 0) return;
    setOpen(true);
    queueMicrotask(() => focusOption(index));
  };
  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };
  const select = (index: number): void => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  return (
    <div ref={rootRef} class="snt-select-menu">
      <button
        ref={triggerRef}
        type="button"
        class="snt-button snt-menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => open ? close(false) : openAt(Math.max(0, currentIndex))}
        onKeyDown={(event) => {
          switch (event.key) {
            case "ArrowDown": event.preventDefault(); openAt(currentIndex >= 0 ? currentIndex : 0); break;
            case "ArrowUp": event.preventDefault(); openAt(currentIndex >= 0 ? currentIndex : options.length - 1); break;
            case "Home": event.preventDefault(); openAt(0); break;
            case "End": event.preventDefault(); openAt(options.length - 1); break;
            case "Enter":
            case " ": event.preventDefault(); open ? close(false) : openAt(Math.max(0, currentIndex)); break;
          }
        }}
      >
        {current?.icon}<span>{current?.label ?? placeholder}</span><span aria-hidden="true">⌄</span>
      </button>
      {open && (
        <div id={menuId} class="snt-select-menu__options snt-float" role="listbox" aria-label={placeholder}>
          {options.map((option, index) => (
            <div
              key={option.value}
              ref={(element) => { optionRefs.current[index] = element; }}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              class="snt-button snt-button--quiet"
              onClick={() => select(index)}
              onKeyDown={(event) => {
                switch (event.key) {
                  case "ArrowDown": event.preventDefault(); focusOption(index + 1); break;
                  case "ArrowUp": event.preventDefault(); focusOption(index - 1); break;
                  case "Home": event.preventDefault(); focusOption(0); break;
                  case "End": event.preventDefault(); focusOption(options.length - 1); break;
                  case "Enter":
                  case " ": event.preventDefault(); select(index); break;
                  case "Escape": event.preventDefault(); event.stopPropagation(); close(true); break;
                  case "Tab": setOpen(false); break;
                }
              }}
            >
              {option.icon}<span>{option.label}</span>{option.tag && <span class="snt-kicker">{option.tag}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
