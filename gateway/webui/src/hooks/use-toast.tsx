import { createContext } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";

const TOAST_DISMISS_MS = 4000;
const TOAST_EXIT_MS = 150;

type ToastTone = "success" | "error";

interface ToastEntry {
  id: number;
  message: string;
  detail?: string;
  tone: ToastTone;
  phase: "visible" | "closing";
}

interface ToastContextValue {
  show(message: string, tone?: ToastTone, detail?: string): void;
  toasts: ToastEntry[];
  dismiss(id: number): void;
}

const Ctx = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: preact.ComponentChildren }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const autoDismissTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const removalTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: number) => {
    autoDismissTimers.current.delete(id);
    removalTimers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const dismiss = useCallback((id: number) => {
    const autoDismissTimer = autoDismissTimers.current.get(id);
    if (autoDismissTimer !== undefined) clearTimeout(autoDismissTimer);
    autoDismissTimers.current.delete(id);
    setToasts((current) => current.map((toast) => toast.id === id ? { ...toast, phase: "closing" } : toast));
    if (removalTimers.current.has(id)) return;
    removalTimers.current.set(id, setTimeout(() => remove(id), TOAST_EXIT_MS));
  }, [remove]);

  const show = useCallback((message: string, tone: ToastTone = "success", detail?: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, ...(detail === undefined ? {} : { detail }), tone, phase: "visible" }]);
    autoDismissTimers.current.set(id, setTimeout(() => dismiss(id), TOAST_DISMISS_MS));
  }, [dismiss]);

  useEffect(() => () => {
    for (const timer of autoDismissTimers.current.values()) clearTimeout(timer);
    for (const timer of removalTimers.current.values()) clearTimeout(timer);
  }, []);

  return <Ctx.Provider value={{ show, toasts, dismiss }}>{children}</Ctx.Provider>;
}

export function useToast(): ToastContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast must be used inside ToastProvider");
  return v;
}
