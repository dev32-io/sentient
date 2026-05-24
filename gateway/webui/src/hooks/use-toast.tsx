import { createContext } from "preact";
import { useCallback, useContext, useState } from "preact/hooks";

const TOAST_DISMISS_MS = 4000;

interface ToastEntry {
  id: number;
  message: string;
  tone: "success" | "error";
}

interface ToastContextValue {
  show(message: string, tone?: "success" | "error"): void;
  toasts: ToastEntry[];
  dismiss(id: number): void;
}

const Ctx = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: preact.ComponentChildren }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const show = useCallback((message: string, tone: "success" | "error" = "success") => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, message, tone }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TOAST_DISMISS_MS);
  }, []);

  const dismiss = useCallback(
    (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)),
    [],
  );

  return <Ctx.Provider value={{ show, toasts, dismiss }}>{children}</Ctx.Provider>;
}

export function useToast(): ToastContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast must be used inside ToastProvider");
  return v;
}
