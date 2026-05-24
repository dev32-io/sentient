import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import { XIcon } from "../../common/icons/x.tsx";

export interface ModalProps {
  title: string;
  children: ComponentChildren;
  footer?: JSX.Element;
  onClose: () => void;
  width?: number;
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  width = 440,
}: ModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div class="modal-scrim" onClick={onClose}>
      <div class="modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <header class="modal-h">
          <h3>{title}</h3>
          <button type="button" class="modal-x" onClick={onClose} aria-label="Close">
            <XIcon size={14} />
          </button>
        </header>
        <div class="modal-b">{children}</div>
        {footer && <footer class="modal-f">{footer}</footer>}
      </div>
    </div>
  );
}
