import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { XIcon } from "./icons/x.tsx";

export interface DialogProps {
  title: string;
  description?: string;
  children?: ComponentChildren;
  footer?: JSX.Element;
  onClose(): void;
  width?: number;
  initialFocusRef?: { current: HTMLElement | null };
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  width = 420,
  initialFocusRef,
}: DialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocus.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  useEffect(() => {
    const target = initialFocusRef?.current;
    if (target) {
      target.focus();
      return;
    }
    // Fall back to the first focusable element so Tab works immediately
    // and the modal owns input from the moment it opens.
    const root = dialogRef.current;
    const first = root?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, [initialFocusRef]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: ESC handled at window scope
    <div class="app-dialog__scrim" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        class="app-dialog"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header class="app-dialog__head">
          <h2 class="app-dialog__title">{title}</h2>
          <button
            type="button"
            class="app-dialog__close"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon size={14} />
          </button>
        </header>
        {(description || children) && (
          <div class="app-dialog__body">
            {description && <p class="app-dialog__desc">{description}</p>}
            {children}
          </div>
        )}
        {footer && <footer class="app-dialog__foot">{footer}</footer>}
      </div>
    </div>
  );
}
