import type { JSX } from "preact";
import type { ScheduledSessionCard } from "@sentient/protocol";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useSessionsContext } from "../../context/sessions.tsx";
import { createSchedulesApi, type SchedulesApi } from "../../services/schedules-api.ts";
import { ActionButton, FoundationIconButton, SurfaceAction } from "../common/foundation.tsx";
import { AsyncState, Notice } from "../common/composites.tsx";
import { XIcon } from "../common/icons/x.tsx";

export interface MessageInboxProps { open: boolean; token: string; onClose(): void; onOpenedSession(): void; api?: SchedulesApi }
function cardText(card: ScheduledSessionCard): string { return card.preview ?? (card.status === "failed" ? "This scheduled message could not be completed." : "This scheduled message was interrupted."); }
function timeText(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }

export function MessageInbox({ open, token, onClose, onOpenedSession, api }: MessageInboxProps): JSX.Element {
  const resolvedApi = useMemo(() => api ?? createSchedulesApi(), [api]);
  const sessions = useSessionsContext();
  const [cards, setCards] = useState<readonly ScheduledSessionCard[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [opening, setOpening] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const load = async () => {
    setState("loading");
    const result = await resolvedApi.cards(token);
    if (result.ok) { setCards([...result.value.cards].sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))); setState("idle"); }
    else setState("error");
  };
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void load(); queueMicrotask(() => closeRef.current?.focus());
    return () => { if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus(); };
  }, [open, token, resolvedApi]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !opening) { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  }, [open, opening, onClose]);
  const activate = async (card: ScheduledSessionCard) => {
    if (opening) return; setOpening(card.sessionId);
    const ok = await sessions.switchTo(card.sessionId); setOpening(null);
    if (ok) { onOpenedSession(); onClose(); }
  };
  return <div class={`message-inbox ${open ? "message-inbox--open" : ""}`} inert={open ? undefined : true} aria-hidden={!open}>
    <SurfaceAction class="message-inbox__backdrop" tabIndex={-1} aria-label="Close messages" onClick={onClose} />
    <aside ref={panelRef} class="message-inbox__panel" role="dialog" aria-modal="true" aria-label="Scheduled messages inbox">
      <header class="message-inbox__header"><div><h2>Messages</h2><p>Replies started by your schedules.</p></div><FoundationIconButton buttonRef={closeRef} label="Close messages" variant="quiet" disabled={Boolean(opening)} onClick={onClose}><XIcon size={16} /></FoundationIconButton></header>
      {sessions.error?.value && <Notice tone="error">Couldn’t open that conversation. It may no longer be available.</Notice>}
      <div class="message-inbox__list">
        {state === "loading" && cards.length === 0 ? <AsyncState state="loading" title="Loading messages" /> : state === "error" && cards.length === 0 ? <AsyncState state="error" title="Couldn’t load messages" action={<ActionButton variant="quiet" onClick={() => void load()}>Try again</ActionButton>} /> : cards.length === 0 ? <AsyncState state="empty" title="No scheduled messages yet" message="Completed scheduled conversations will appear here." /> : <ul>{cards.map((card) => <li key={card.occurrenceId}><SurfaceAction class="message-card" onClick={() => void activate(card)} disabled={Boolean(opening)} aria-label={`Open scheduled message from ${timeText(card.completedAt)}`}><strong>{cardText(card)}</strong><small>{timeText(card.completedAt)}</small></SurfaceAction></li>)}</ul>}
      </div>
    </aside>
  </div>;
}
