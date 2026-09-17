import type { JSX } from "preact";
import type { ScheduledSessionCard } from "@sentient/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { useSessionsContext } from "../../context/sessions.tsx";
import { createSchedulesApi, type SchedulesApi } from "../../services/schedules-api.ts";
import { Dialog, isLiveDialogRoot } from "../common/dialog.tsx";
import { ActionButton, FoundationIconButton, SurfaceAction } from "../common/foundation.tsx";
import { AsyncState, Notice } from "../common/composites.tsx";
import { XIcon } from "../common/icons/x.tsx";

export interface MessageInboxProps { open: boolean; token: string; onClose(): void; onOpenedSession(): void; api?: SchedulesApi }

type ClearFailure = { card: ScheduledSessionCard; closeAfter: boolean };
type Swipe = { id: string; pointerId: number; x: number; y: number };

function cardText(card: ScheduledSessionCard): string {
  return card.preview ?? (card.status === "failed" ? "This scheduled message could not be completed." : "This scheduled message was interrupted.");
}
function timeText(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function sorted(cards: readonly ScheduledSessionCard[]): ScheduledSessionCard[] {
  return [...new Map(cards.map((card) => [card.occurrenceId, card])).values()]
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));
}

export function MessageInbox({ open, token, onClose, onOpenedSession, api }: MessageInboxProps): JSX.Element {
  const resolvedApi = useMemo(() => api ?? createSchedulesApi(), [api]);
  const sessions = useSessionsContext();
  const [cards, setCards] = useState<readonly ScheduledSessionCard[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const [clearFailure, setClearFailure] = useState<ClearFailure | null>(null);
  const [clearAllPhase, setClearAllPhase] = useState<"closed" | "confirm" | "unknown" | "retry">("closed");
  const [clearAllUnknown, setClearAllUnknown] = useState(false);
  const [reconciliationError, setReconciliationError] = useState(false);
  const [clearRefreshError, setClearRefreshError] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const clearAllRef = useRef<HTMLButtonElement | null>(null);
  const clearAllTargetsRef = useRef<readonly string[] | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const loadMoreRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const contextRef = useRef(0);
  const identityRef = useRef(token);
  const controllerRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const replacementGenerationRef = useRef<number | null>(null);
  const repairAfterReplacementRef = useRef(false);
  const swipeRef = useRef<Swipe | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const clearAllOpen = clearAllPhase !== "closed";

  const current = (context: number, signal: AbortSignal): boolean =>
    contextRef.current === context && !signal.aborted;

  const repairFocus = (preferredOccurrence?: string): void => {
    queueMicrotask(() => {
      const panel = panelRef.current;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!panel || (panel.contains(active) && active !== panel && !active?.matches(":disabled"))) return;
      const rows = Array.from(panel.querySelectorAll<HTMLElement>(".message-card-row"));
      const preferred = rows.find((row) => row.dataset.occurrenceId === preferredOccurrence);
      (preferred?.querySelector<HTMLElement>(".message-card:not(:disabled)") ?? rows[0]?.querySelector<HTMLElement>(".message-card:not(:disabled)") ?? (closeRef.current?.disabled ? null : closeRef.current) ?? panel).focus();
    });
  };

  const loadPage = useCallback(async (
    cursor: string | undefined,
    replace: boolean,
    context: number,
    signal: AbortSignal,
    preserveExisting = false,
  ): Promise<boolean | undefined> => {
    const generation = ++loadGenerationRef.current;
    if (replace) {
      replacementGenerationRef.current = generation;
      if (!preserveExisting) setCards([]);
      setNextCursor(undefined);
      setLoadingMore(false);
      setState("loading");
    } else {
      setLoadingMore(true);
      setLoadMoreError(false);
    }
    const result = await resolvedApi.cards(token, cursor, signal);
    if (!current(context, signal) || loadGenerationRef.current !== generation) return undefined;
    if (replace) replacementGenerationRef.current = null;
    if (result.ok) {
      setCards((existing) => sorted(replace ? result.value.cards : [...existing, ...result.value.cards]));
      setNextCursor(result.value.nextCursor);
      setState("idle");
      if (replace) {
        setClearAllUnknown(false);
        setReconciliationError(false);
      }
    } else if (replace) {
      setState("error");
    } else {
      setLoadMoreError(true);
    }
    setLoadingMore(false);
    if (repairAfterReplacementRef.current && replace) {
      repairAfterReplacementRef.current = false;
      repairFocus();
    }
    return result.ok;
  }, [resolvedApi, token]);

  const reloadAfterClear = async (context: number, signal: AbortSignal, repairAfter = false): Promise<void> => {
    if (repairAfter) repairAfterReplacementRef.current = true;
    setClearRefreshError(false);
    const ok = await loadPage(undefined, true, context, signal, true);
    if (ok !== undefined && current(context, signal)) setClearRefreshError(!ok);
  };

  useEffect(() => {
    const context = ++contextRef.current;
    const identityChanged = identityRef.current !== token;
    identityRef.current = token;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setOpening(null);
    setClearing(null);
    setClearFailure(null);
    setClearAllPhase("closed");
    clearAllTargetsRef.current = null;
    if (identityChanged) {
      setClearAllUnknown(false);
      setReconciliationError(false);
    }
    setClearRefreshError(false);
    setRevealed(null);
    setLoadMoreError(false);
    loadGenerationRef.current += 1;
    replacementGenerationRef.current = null;
    repairAfterReplacementRef.current = false;
    if (open) void loadPage(undefined, true, context, controller.signal);
    else {
      setCards([]);
      setNextCursor(undefined);
      setState("idle");
    }
    return () => {
      controller.abort();
      if (contextRef.current === context) contextRef.current += 1;
    };
  }, [open, loadPage]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueMicrotask(() => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']")).filter(isLiveDialogRoot);
      if (dialogs[dialogs.length - 1] === panelRef.current) closeRef.current?.focus();
    });
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || state === "loading" || clearAllOpen) return;
    queueMicrotask(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']")).filter(isLiveDialogRoot);
      if (dialogs[dialogs.length - 1] !== panel) return;
      const target = closeRef.current && !closeRef.current.disabled ? closeRef.current : panel;
      target.focus();
    });
  }, [clearAllOpen, open, state]);

  const busy = Boolean(opening || clearing || loadingMore);
  const mutationsBusy = busy || state === "loading" || clearAllUnknown;

  useEffect(() => {
    if (clearAllPhase === "unknown" || clearAllPhase === "retry") queueMicrotask(() => cancelRef.current?.focus());
  }, [clearAllPhase]);

  useEffect(() => {
    if (!open || clearAllOpen) return;
    const key = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        panelRef.current?.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!panelRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [busy, clearAllOpen, onClose, open]);

  const clearOne = async (card: ScheduledSessionCard, closeAfter: boolean): Promise<void> => {
    if (replacementGenerationRef.current !== null || clearAllUnknown) return;
    const context = contextRef.current;
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedRow = active?.closest<HTMLElement>(".message-card-row");
    const shouldRepairFocus = !closeAfter && focusedRow?.dataset.occurrenceId === card.occurrenceId;
    const cardIndex = cards.findIndex((item) => item.occurrenceId === card.occurrenceId);
    const preferredFocus = cards[cardIndex + 1]?.occurrenceId ?? cards[cardIndex - 1]?.occurrenceId;
    setClearing(card.sessionId);
    setClearFailure(null);
    const result = await resolvedApi.clearCard(token, card.sessionId, signal);
    if (!current(context, signal)) return;
    if (!result.ok) {
      setClearing(null);
      setClearFailure({ card, closeAfter });
      return;
    }
    setCards((existing) => existing.filter((item) => item.occurrenceId !== card.occurrenceId));
    setNextCursor(undefined);
    setRevealed(null);
    if (shouldRepairFocus) repairFocus(preferredFocus);
    if (closeAfter) {
      setClearing(null);
      onClose();
      return;
    }
    await reloadAfterClear(context, signal);
    setClearing(null);
    if (shouldRepairFocus) repairFocus(preferredFocus);
  };

  const activate = async (card: ScheduledSessionCard): Promise<void> => {
    if (busy || replacementGenerationRef.current !== null || clearAllUnknown) return;
    const context = contextRef.current;
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    setOpening(card.sessionId);
    setClearFailure(null);
    const ok = await sessions.switchTo(card.sessionId);
    if (!current(context, signal)) return;
    setOpening(null);
    if (!ok) return;
    onOpenedSession();
    await clearOne(card, true);
  };

  const loadMore = async (): Promise<void> => {
    const signal = controllerRef.current?.signal;
    if (!nextCursor || !signal || busy || replacementGenerationRef.current !== null) return;
    const restoreFocus = document.activeElement === loadMoreRef.current;
    const previousCount = cards.length;
    if (!await loadPage(nextCursor, false, contextRef.current, signal) || !restoreFocus) return;
    queueMicrotask(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const cardActions = Array.from(panel.querySelectorAll<HTMLElement>(".message-card"));
      (cardActions[Math.min(previousCount, cardActions.length - 1)] ?? closeRef.current)?.focus();
    });
  };

  const clearAll = async (): Promise<void> => {
    const context = contextRef.current;
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted || clearing || replacementGenerationRef.current !== null) return;
    const occurrenceIds = clearAllTargetsRef.current ?? cards.map((card) => card.occurrenceId);
    clearAllTargetsRef.current = occurrenceIds;
    setClearing("all");
    const result = await resolvedApi.clearCards(token, occurrenceIds, signal);
    if (!current(context, signal)) return;
    setClearing(null);
    if (!result.ok) {
      setClearAllUnknown(true);
      setReconciliationError(false);
      setClearAllPhase("unknown");
      return;
    }
    setClearAllUnknown(false);
    setReconciliationError(false);
    setClearAllPhase("closed");
    clearAllTargetsRef.current = null;
    const cleared = new Set(occurrenceIds);
    setCards((existing) => existing.filter((card) => !cleared.has(card.occurrenceId)));
    setNextCursor(undefined);
    await reloadAfterClear(context, signal);
    repairFocus();
  };

  const reconcileClearAll = async (): Promise<void> => {
    const context = contextRef.current;
    const signal = controllerRef.current?.signal;
    if (!signal || signal.aborted) return;
    setReconciliationError(false);
    const ok = await loadPage(undefined, true, context, signal, true);
    if (ok === undefined) return;
    if (ok) {
      setClearAllUnknown(false);
      setClearAllPhase("closed");
      clearAllTargetsRef.current = null;
    } else {
      setReconciliationError(true);
      setState("idle");
    }
    repairFocus();
  };

  const pointerDown = (card: ScheduledSessionCard, event: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
    if (event.isPrimary === false || mutationsBusy || replacementGenerationRef.current !== null) return;
    swipeRef.current = { id: card.occurrenceId, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const pointerUp = (card: ScheduledSessionCard, event: JSX.TargetedPointerEvent<HTMLButtonElement>): void => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || start.id !== card.occurrenceId || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (dx > -48 || Math.abs(dx) <= Math.abs(dy)) return;
    suppressClickRef.current = card.occurrenceId;
    setRevealed(card.occurrenceId);
    window.setTimeout(() => {
      if (suppressClickRef.current === card.occurrenceId) suppressClickRef.current = null;
    }, 0);
  };
  const cardClick = (card: ScheduledSessionCard): void => {
    if (suppressClickRef.current === card.occurrenceId) {
      suppressClickRef.current = null;
      return;
    }
    void activate(card);
  };

  return <div class={`message-inbox ${open ? "message-inbox--open" : ""}`} inert={open ? undefined : true} aria-hidden={!open}>
    <SurfaceAction class="message-inbox__backdrop" tabIndex={-1} aria-label="Close messages" onClick={() => { if (!busy && !clearAllOpen) onClose(); }} />
    <aside ref={panelRef} class="message-inbox__panel" role="dialog" aria-modal="true" aria-label="Scheduled messages inbox" tabIndex={-1}>
      <header class="message-inbox__header">
        <div><h2>Messages</h2><p>Replies started by your schedules.</p></div>
        <div class="message-inbox__header-actions">
          <ActionButton buttonRef={clearAllRef} variant="destructive" disabled={busy || cards.length === 0 || state !== "idle"} onClick={() => { if (!clearAllUnknown) clearAllTargetsRef.current = null; clearAllRef.current?.focus(); setClearAllPhase(clearAllUnknown ? "unknown" : "confirm"); }}>Clear all</ActionButton>
          <FoundationIconButton buttonRef={closeRef} label="Close messages" variant="quiet" disabled={busy} onClick={onClose}><XIcon size={16} /></FoundationIconButton>
        </div>
      </header>
      {sessions.error?.value && <Notice tone="error">Couldn’t open that conversation. It may no longer be available.</Notice>}
      {clearFailure && <Notice tone="error" title="Couldn’t clear this message" action={<ActionButton variant="quiet" disabled={mutationsBusy} onClick={() => void clearOne(clearFailure.card, clearFailure.closeAfter)}>Try clearing again</ActionButton>}>{clearFailure.closeAfter ? "Conversation opened, but this inbox entry remains." : "Inbox entry remains unchanged."}</Notice>}
      {clearAllUnknown && !clearAllOpen && <Notice tone="error" title="Clear outcome unknown" action={<ActionButton variant="quiet" loading={state === "loading"} onClick={() => void reconcileClearAll()}>Reload</ActionButton>}>
        {reconciliationError ? "Couldn’t reload messages. Clear outcome remains unknown." : "Reload messages to reconcile before retrying clear all."}
      </Notice>}
      {clearRefreshError && cards.length > 0 && <Notice tone="error" title="Clear succeeded" action={<ActionButton variant="quiet" disabled={busy} onClick={() => {
        const signal = controllerRef.current?.signal;
        if (signal) void reloadAfterClear(contextRef.current, signal, true);
      }}>Reload</ActionButton>}>Couldn’t refresh remaining messages. Loaded results may be stale.</Notice>}
      <div class="message-inbox__list">
        {state === "loading" && cards.length === 0 ? <AsyncState state="loading" title="Loading messages" /> : state === "error" && clearRefreshError && cards.length === 0 ? <AsyncState state="error" title="Clear succeeded" message="Couldn’t refresh messages." action={<ActionButton variant="quiet" onClick={() => {
          const signal = controllerRef.current?.signal;
          if (signal) void reloadAfterClear(contextRef.current, signal, true);
        }}>Reload</ActionButton>} /> : state === "error" && cards.length === 0 ? <AsyncState state="error" title="Couldn’t load messages" action={<ActionButton variant="quiet" onClick={() => {
          const signal = controllerRef.current?.signal;
          if (signal) void loadPage(undefined, true, contextRef.current, signal);
        }}>Try again</ActionButton>} /> : cards.length === 0 ? <AsyncState state="empty" title="No scheduled messages yet" message="Completed scheduled conversations will appear here." /> : <>
          <ul>{cards.map((card) => {
            const isRevealed = revealed === card.occurrenceId;
            return <li key={card.occurrenceId} class="message-card-row" data-occurrence-id={card.occurrenceId} data-revealed={isRevealed || undefined}>
              {isRevealed && <ActionButton className="message-card-row__swipe-clear" variant="destructive" disabled={mutationsBusy} ariaLabel={`Clear scheduled message from ${timeText(card.completedAt)}`} onClick={() => void clearOne(card, false)}>Clear</ActionButton>}
              <div class="message-card-row__foreground">
                <SurfaceAction
                  class="message-card"
                  onClick={() => cardClick(card)}
                  onPointerDown={(event) => pointerDown(card, event)}
                  onPointerUp={(event) => pointerUp(card, event)}
                  onPointerCancel={() => { swipeRef.current = null; }}
                  disabled={mutationsBusy}
                  aria-label={`Open scheduled message from ${timeText(card.completedAt)}`}
                ><strong>{cardText(card)}</strong><small>{timeText(card.completedAt)}</small></SurfaceAction>
                {!isRevealed && <FoundationIconButton className="message-card-row__clear" variant="quiet" disabled={mutationsBusy} label={`Clear notification from ${timeText(card.completedAt)}`} onClick={() => void clearOne(card, false)}><XIcon size={16} /></FoundationIconButton>}
              </div>
            </li>;
          })}</ul>
          {loadMoreError && <Notice tone="error" action={<ActionButton variant="quiet" disabled={busy} onClick={() => void loadMore()}>Try again</ActionButton>}>Couldn’t load more messages.</Notice>}
          {nextCursor && <div class="message-inbox__pagination"><ActionButton buttonRef={loadMoreRef} variant="quiet" loading={loadingMore} disabled={Boolean(opening || clearing)} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</ActionButton></div>}
        </>}
      </div>
    </aside>
    {clearAllOpen && <Dialog
      title={clearAllPhase === "unknown" ? "Clear outcome unknown" : clearAllPhase === "retry" ? "Retry clear all?" : "Clear all messages?"}
      description={clearAllPhase === "unknown"
        ? "Request may have cleared messages. Reload to reconcile before retrying."
        : clearAllPhase === "retry"
          ? "Retries target only the same confirmed messages. Chats and messages stay."
          : "This clears the notification entries currently shown. Chats and messages stay."}
      children={clearAllPhase === "unknown" && reconciliationError
        ? <Notice tone="error">Couldn’t reload messages. Clear outcome remains unknown. Try Reload again.</Notice>
        : undefined}
      initialFocusRef={cancelRef}
      closeOnBackdrop={!clearing && state !== "loading"}
      closeOnEscape={!clearing && state !== "loading"}
      onClose={() => { if (!clearing && replacementGenerationRef.current === null) setClearAllPhase("closed"); }}
      footer={clearAllPhase === "unknown" ? <>
        <ActionButton buttonRef={cancelRef} variant="quiet" disabled={state === "loading"} onClick={() => { if (replacementGenerationRef.current === null) setClearAllPhase("closed"); }}>Close</ActionButton>
        <ActionButton variant="quiet" loading={state === "loading"} onClick={() => void reconcileClearAll()}>Reload</ActionButton>
        <ActionButton variant="destructive" disabled={state === "loading"} onClick={() => { if (replacementGenerationRef.current === null) setClearAllPhase("retry"); }}>Retry clear all…</ActionButton>
      </> : <>
        <ActionButton buttonRef={cancelRef} variant="quiet" disabled={Boolean(clearing)} onClick={() => setClearAllPhase(clearAllPhase === "retry" ? "unknown" : "closed")}>{clearAllPhase === "retry" ? "Back" : "Cancel"}</ActionButton>
        <ActionButton variant="destructive" loading={clearing === "all"} onClick={() => void clearAll()}>{clearAllPhase === "retry" ? "Retry clear all" : "Clear all"}</ActionButton>
      </>}
    />}
  </div>;
}
