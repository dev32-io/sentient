import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Icon } from "../common/icon.tsx";
import { ActionButton, FoundationIconButton } from "../common/foundation.tsx";

export interface RowMenuProps {
  onRename(): void;
  onDelete(): void;
}

const POPOVER_HEIGHT_GUESS = 88;

/**
 * Whether this menu has anything that works.
 *
 * Rename and Delete are its only two entries, and BOTH 404 today: the
 * gateway's sessions REST surface is list + messages only
 * (`gateway/src/api/handlers/sessions.ts`) — `PATCH` and `DELETE` are not
 * implemented, and no task in the session-model plan adds them.
 *
 * Shipping them wired was worse than not shipping them. `use-sessions.ts`
 * calls `sessions.rename` as `void …`, so the dialog closed on Save, the row
 * silently kept its old name, and the ONLY feedback anywhere was a
 * browser-console WARN. Two affordances presented as working.
 *
 * The whole trigger is hidden rather than the two items, because a "Chat
 * options" button opening an empty popover is the same defect with an extra
 * click. The dialogs, the handlers and the SDK methods all stay — flip this to
 * `true` when the routes land and the feature is whole again.
 */
const ROW_ACTIONS_AVAILABLE = false;

export function RowMenu({ onRename, onDelete }: RowMenuProps): JSX.Element | null {
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

  // AFTER the hooks, never before: an early return above them would change the
  // hook order between renders the moment this flips to true.
  if (!ROW_ACTIONS_AVAILABLE) return null;

  return (
    <div class="row-menu" ref={wrapRef}>
      <FoundationIconButton
        label="Chat options"
        buttonRef={triggerRef}
        className={`row-menu__trigger ${open ? "row-menu__trigger--open" : ""}`}
        expanded={open}
        hasPopup="menu"
        onClick={(event) => { event.stopPropagation(); setOpen((value) => !value); }}
      >
        <Icon name="more-horizontal" size={16} />
      </FoundationIconButton>
      {open && (
        <div ref={popRef} class={popClass} role="menu">
          <ActionButton variant="quiet" className="row-menu__item" role="menuitem" onClick={(event) => { event.stopPropagation(); setOpen(false); onRename(); }}>
            <Icon name="pencil" size={14} /> Rename
          </ActionButton>
          <ActionButton variant="destructive" className="row-menu__item row-menu__item--danger" role="menuitem" onClick={(event) => { event.stopPropagation(); setOpen(false); onDelete(); }}>
            <Icon name="trash" size={14} /> Delete
          </ActionButton>
        </div>
      )}
    </div>
  );
}
