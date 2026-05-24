import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../common/icon.tsx";

export interface RowMenuProps {
  onRename(): void;
  onDelete(): void;
}

const POPOVER_HEIGHT_GUESS = 88;

export function RowMenu({ onRename, onDelete }: RowMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [flipUp, setFlipUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setFlipUp(false);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const tr = trigger.getBoundingClientRect();
    const popH = popRef.current?.offsetHeight ?? POPOVER_HEIGHT_GUESS;
    const room = window.innerHeight - tr.bottom;
    setFlipUp(room < popH + 16 && tr.top > popH + 16);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(
          popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
        );
        if (items.length === 0) return;
        const active = document.activeElement as HTMLElement | null;
        const idx = items.indexOf(active as HTMLElement);
        const next = e.key === "ArrowDown"
          ? (idx + 1) % items.length
          : (idx - 1 + items.length) % items.length;
        e.preventDefault();
        items[next]?.focus();
      }
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey, true);
    const first = popRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const popClass = [
    "row-menu__pop",
    flipUp && "row-menu__pop--up",
  ].filter(Boolean).join(" ");

  return (
    <div class="row-menu" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        class={`row-menu__trigger ${open ? "row-menu__trigger--open" : ""}`}
        aria-label="Chat options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      {open && (
        <div ref={popRef} class={popClass} role="menu">
          <button
            type="button"
            class="row-menu__item"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onRename();
            }}
          >
            <Icon name="pencil" size={14} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            class="row-menu__item row-menu__item--danger"
            role="menuitem"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
          >
            <Icon name="trash" size={14} />
            <span>Delete</span>
          </button>
        </div>
      )}
    </div>
  );
}
