import type { JSX } from "preact";
import { useToast } from "../../hooks/use-toast.js";
import { Icon } from "./icon.js";

export function ToastHost(): JSX.Element {
  const { toasts, dismiss } = useToast();
  return (
    <div class="toast-host">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          class={`toast toast--${toast.tone}${toast.phase === "closing" ? " toast--closing" : ""}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span class="toast__icon" aria-hidden="true">
            <Icon name={toast.tone === "success" ? "check" : "x"} size={20} />
          </span>
          <span class="toast__content">
            <strong>{toast.message}</strong>
            {toast.detail && <small>{toast.detail}</small>}
          </span>
          <button
            type="button"
            class="toast__dismiss"
            aria-label="Dismiss notification"
            onClick={() => dismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
