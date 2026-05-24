import type { JSX } from "preact";
import { useToast } from "../../hooks/use-toast.js";

export function ToastHost(): JSX.Element {
  const { toasts, dismiss } = useToast();
  return (
    <div class="toast-host" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" class={`toast toast--${t.tone}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  );
}
