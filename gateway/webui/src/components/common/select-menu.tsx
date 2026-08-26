import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";

export interface SelectMenuOption {
  value: string;
  label: string;
  icon?: JSX.Element | undefined;
  tag?: string | undefined;
  disabled?: boolean | undefined;
}

export interface SelectMenuProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectMenuOption[];
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
}

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

function nextEnabled(options: readonly SelectMenuOption[], start: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (start + offset * direction + options.length * 2) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

/** Keyboard-accessible custom select used where native option rendering is insufficient. */
export function SelectMenu({ value, onChange, options, placeholder = "Select…", disabled = false, className }: SelectMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);
  const menuId = useId();
  const currentIndex = options.findIndex((option) => option.value === value);
  const current = currentIndex >= 0 ? options[currentIndex] : undefined;

  const focusOption = (index: number, direction: 1 | -1 = 1): void => {
    const enabled = nextEnabled(options, index, direction);
    if (enabled >= 0) optionRefs.current[enabled]?.focus();
  };
  const openAt = (index: number, direction: 1 | -1 = 1): void => {
    if (disabled || options.length === 0) return;
    setOpen(true);
    queueMicrotask(() => focusOption(index, direction));
  };
  const close = (restoreFocus: boolean): void => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  };
  const select = (index: number): void => {
    const option = options[index];
    if (!option || option.disabled) return;
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
    <div ref={rootRef} class={classes("snt-select-menu", className)}>
      <button
        ref={triggerRef}
        type="button"
        class="snt-button snt-menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={disabled}
        onClick={() => open ? close(false) : openAt(currentIndex >= 0 ? currentIndex : 0)}
        onKeyDown={(event) => {
          switch (event.key) {
            case "ArrowDown": event.preventDefault(); openAt(currentIndex >= 0 ? currentIndex : 0, 1); break;
            case "ArrowUp": event.preventDefault(); openAt(currentIndex >= 0 ? currentIndex : options.length - 1, -1); break;
            case "Home": event.preventDefault(); openAt(0, 1); break;
            case "End": event.preventDefault(); openAt(options.length - 1, -1); break;
            case "Enter":
            case " ": event.preventDefault(); open ? close(false) : openAt(currentIndex >= 0 ? currentIndex : 0); break;
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
              tabIndex={option.disabled ? -1 : 0}
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              class={classes("snt-button snt-button--quiet", option.disabled && "snt-select-menu__option--disabled")}
              onClick={() => select(index)}
              onKeyDown={(event) => {
                switch (event.key) {
                  case "ArrowDown": event.preventDefault(); focusOption(index + 1, 1); break;
                  case "ArrowUp": event.preventDefault(); focusOption(index - 1, -1); break;
                  case "Home": event.preventDefault(); focusOption(0, 1); break;
                  case "End": event.preventDefault(); focusOption(options.length - 1, -1); break;
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
