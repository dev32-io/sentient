import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { XIcon } from "./icons/x.tsx";

export type DialogCloseReason = "escape" | "backdrop" | "close-button";

export interface DialogProps {
  title: string;
  description?: string;
  children?: ComponentChildren;
  footer?: JSX.Element;
  /** The callback used for an already-approved/programmatic close. */
  onClose(): void;
  width?: number;
  initialFocusRef?: { current: HTMLElement | null };
  /** Background isolation is on by default; false is retained only as a compatibility escape hatch. */
  inertBackground?: boolean;
  /** Source-compatible spelling for callers that describe the backdrop. */
  backgroundInert?: boolean;
  /**
   * Whether a click on the scrim is allowed to request dismissal. Defaults to
   * true to preserve the original primitive behavior.
   */
  closeOnBackdrop?: boolean;
  /** Source-compatible spelling for the same backdrop policy. */
  dismissOnBackdrop?: boolean;
  /** Whether Escape is allowed to request dismissal. Defaults to true. */
  closeOnEscape?: boolean;
  /** Source-compatible spelling for the same Escape policy. */
  dismissOnEscape?: boolean;
  /**
   * When true, dismissal requests are ignored unless onRequestClose is
   * supplied. This lets a dirty editor interpose a discard confirmation.
   */
  safeClose?: boolean;
  /** Handle Escape, scrim, and close-button requests before closing. */
  onRequestClose?: (reason: DialogCloseReason) => void;
  /** Alias for integrations that call this an onDismissRequest callback. */
  onDismissRequest?: (reason: DialogCloseReason) => void;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let nextDialogId = 0;

type InertSnapshot = {
  readonly inertAttribute: string | null;
  readonly inertProperty: boolean | undefined;
  readonly ariaHidden: string | null;
};

type InertState = InertSnapshot & { readonly tokens: Set<symbol> };

// A stack-like registry makes nested dialogs safe: closing a child restores
// the parent's inert state rather than prematurely exposing the background.
const inertStates = new WeakMap<HTMLElement, InertState>();

function inertProperty(element: HTMLElement): boolean | undefined {
  if (!("inert" in element)) return undefined;
  return Boolean((element as HTMLElement & { inert?: boolean }).inert);
}

function isInert(element: HTMLElement): boolean {
  return element.hasAttribute("inert") || inertProperty(element) === true;
}

function isHidden(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (current.hidden || current.getAttribute("aria-hidden")?.toLowerCase() === "true" || isInert(current)) return true;
    try {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
    } catch {
      // A detached or tearing-down document may not have computed styles.
    }
    current = current.parentElement;
  }
  return false;
}

function isLiveDialogRoot(element: HTMLElement): boolean {
  return element.isConnected && !isHidden(element);
}

function outsideTreeElements(root: HTMLElement): HTMLElement[] {
  const targets = new Set<HTMLElement>();
  let current: HTMLElement | null = root;
  while (current && current !== document.body) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) break;
    for (const child of Array.from(parent.children)) {
      if (child !== current && child instanceof HTMLElement) targets.add(child);
    }
    current = parent;
  }
  return [...targets];
}

function applyInert(element: HTMLElement, value: boolean): void {
  const target = element as HTMLElement & { inert?: boolean };
  if ("inert" in element || value) target.inert = value;
  if (value) element.setAttribute("inert", "");
  else element.removeAttribute("inert");
}

function restoreInert(element: HTMLElement, snapshot: InertSnapshot): void {
  if (snapshot.inertProperty !== undefined) {
    (element as HTMLElement & { inert?: boolean }).inert = snapshot.inertProperty;
  }
  if (snapshot.inertAttribute === null) element.removeAttribute("inert");
  else element.setAttribute("inert", snapshot.inertAttribute);
  if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", snapshot.ariaHidden);
}

function isolateBackground(element: HTMLElement): () => void {
  let state = inertStates.get(element);
  if (!state) {
    state = {
      inertAttribute: element.getAttribute("inert"),
      inertProperty: inertProperty(element),
      ariaHidden: element.getAttribute("aria-hidden"),
      tokens: new Set<symbol>(),
    };
    inertStates.set(element, state);
  }
  const token = Symbol("dialog-inert");
  state.tokens.add(token);
  applyInert(element, true);
  element.setAttribute("aria-hidden", "true");

  return () => {
    const current = inertStates.get(element);
    if (!current || !current.tokens.delete(token)) return;
    if (current.tokens.size > 0) {
      applyInert(element, true);
      element.setAttribute("aria-hidden", "true");
      return;
    }
    inertStates.delete(element);
    restoreInert(element, current);
  };
}

function focusElement(element: HTMLElement | null): void {
  if (!element || !element.isConnected) return;
  try {
    element.focus();
  } catch {
    // A browser may reject focus while its document is being torn down.
  }
}

export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  width = 420,
  initialFocusRef,
  inertBackground,
  backgroundInert,
  closeOnBackdrop,
  dismissOnBackdrop,
  closeOnEscape,
  dismissOnEscape,
  safeClose = false,
  onRequestClose,
  onDismissRequest,
}: DialogProps): JSX.Element {
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useRef(`app-dialog-title-${++nextDialogId}`);
  const descriptionId = useRef(`app-dialog-description-${nextDialogId}`);
  const requestClose = (reason: DialogCloseReason): void => {
    if (reason === "backdrop" && (closeOnBackdrop ?? dismissOnBackdrop ?? true) === false) return;
    if (reason === "escape" && (closeOnEscape ?? dismissOnEscape ?? true) === false) return;
    const request = onRequestClose ?? onDismissRequest;
    if (request) {
      request(reason);
      return;
    }
    if (safeClose) return;
    onClose();
  };

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    return () => focusElement(previousFocus.current);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const root = dialogRef.current;
      if (!root) return;
      const openDialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']"))
        .filter(isLiveDialogRoot);
      if (openDialogs[openDialogs.length - 1] !== root) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        requestClose("escape");
        return;
      }
      if (e.key !== "Tab") return;
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
      } else if (!root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [closeOnBackdrop, closeOnEscape, dismissOnBackdrop, dismissOnEscape, onClose, onDismissRequest, onRequestClose, safeClose]);

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

  useEffect(() => {
    if (!(inertBackground ?? backgroundInert ?? true)) return;
    const scrim = scrimRef.current;
    if (!scrim) return;
    const cleanups = outsideTreeElements(scrim).map((element) => isolateBackground(element));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [backgroundInert, inertBackground]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: ESC handled at window scope
    <div
      ref={scrimRef}
      class="app-dialog__scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose("backdrop");
      }}
      role="presentation"
    >
      <div
        ref={dialogRef}
        class="app-dialog"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        {...(description ? { "aria-describedby": descriptionId.current } : {})}
      >
        <header class="app-dialog__head">
          <h2 id={titleId.current} class="app-dialog__title">{title}</h2>
          <button
            type="button"
            class="app-dialog__close"
            onClick={() => requestClose("close-button")}
            aria-label="Close"
          >
            <XIcon size={14} />
          </button>
        </header>
        {(description || children) && (
          <div class="app-dialog__body">
            {description && <p id={descriptionId.current} class="app-dialog__desc">{description}</p>}
            {children}
          </div>
        )}
        {footer && <footer class="app-dialog__foot">{footer}</footer>}
      </div>
    </div>
  );
}
