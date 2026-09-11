import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useSessionsContext } from "../../context/sessions.tsx";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog.tsx";
import { NewChatButton } from "./new-chat-button.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { SessionList } from "./session-list.tsx";
import { SessionSearchBox } from "./session-search-box.tsx";
import { ActionButton, FoundationIconButton } from "../common/foundation.tsx";
import { AsyncState, NoResultsState, Notice } from "../common/composites.tsx";
import { XIcon } from "../common/icons/x.tsx";
import { StaleBanner } from "./stale-banner.tsx";

const EMPTY_DEFAULT = "No past chats yet.";
const EMPTY_LOAD_FAIL = "Couldn't load sessions — try again.";

interface PendingTarget {
  id: string;
  title: string;
}

export interface DrawerProps {
  open: boolean;
  onClose(): void;
  onBeforeSessionChange?: () => Promise<boolean>;
  onSessionSelected?: () => void;
}

export function Drawer({ open, onClose, onBeforeSessionChange, onSessionSelected }: DrawerProps): JSX.Element {
  const sessions = useSessionsContext();
  const [clearSearchSignal, setClearSearchSignal] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<PendingTarget | null>(null);
  const [deleting, setDeleting] = useState<PendingTarget | null>(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const revisionRef = useRef(0);
  const cancelledFocusRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Closing/replacing the authenticated context invalidates every awaiting action,
  // including a guard that has not yet allowed any session side effects.
  useLayoutEffect(() => {
    revisionRef.current += 1;
    pendingRef.current = false;
    cancelledFocusRef.current = null;
    setPending(false);
    return () => {
      revisionRef.current += 1;
      cancelledFocusRef.current = null;
    };
  }, [open, sessions]);

  useLayoutEffect(() => {
    const target = cancelledFocusRef.current;
    if (pending || !open || !target) return;
    const revision = revisionRef.current;
    // Dialog cleanup may attempt restoration before the initiating button is
    // enabled. Wait for both the enabled DOM and background isolation cleanup.
    const frame = requestAnimationFrame(() => {
      if (revisionRef.current !== revision) return;
      cancelledFocusRef.current = null;
      if (target.isConnected && !target.closest("[inert]")) target.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pending, open, sessions]);

  const requestClose = (): void => {
    if (!pendingRef.current) onClose();
  };

  // Lazy-load on first open. Subsequent opens still re-fetch so the list
  // reflects new chats from other tabs / since-last-view.
  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement as HTMLElement | null;
    void sessions.load();
    closeRef.current?.focus();
    return () => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus();
    };
  }, [open, sessions]);

  // Escape closes the drawer — but only when no dialog is open. Dialog and
  // row-menu register capture-phase ESC handlers that stopPropagation, so
  // this bubble-phase listener never fires while one of them is up. The
  // dialog-state guard below is belt-and-suspenders for the dialog case.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        if (renaming || deleting) return;
        e.preventDefault();
        if (!pendingRef.current) onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, renaming, deleting]);

  const searchActive = sessions.searchHits.value !== null;
  const visible = sessions.searchHits.value ?? sessions.items.value;
  const hasError = sessions.error.value !== null;
  const emptyMessage = hasError ? EMPTY_LOAD_FAIL : EMPTY_DEFAULT;
  const showLoadingBlank = sessions.loading.value && sessions.items.value.length === 0;
  const showNoResults = searchActive && !hasError && !showLoadingBlank && visible.length === 0;
  const showStaleBanner = visible.length > 0 && (hasError || sessions.loading.value);
  const clearSearch = (): void => {
    setClearSearchSignal((value) => (value ?? 0) + 1);
    void sessions.search("");
  };

  const changeSession = async (operation: () => Promise<boolean>, target: HTMLElement): Promise<void> => {
    if (!open || pendingRef.current) return;
    const revision = revisionRef.current;
    const isCurrent = () => revisionRef.current === revision;
    cancelledFocusRef.current = null;
    pendingRef.current = true;
    setPending(true);
    setActionError(null);
    try {
      if (onBeforeSessionChange) {
        const allowed = await onBeforeSessionChange();
        if (!isCurrent()) return;
        if (!allowed) {
          cancelledFocusRef.current = target;
          return;
        }
      }
      const succeeded = await operation();
      if (!isCurrent()) return;
      if (!succeeded) {
        setActionError("Couldn't open chat. Try again.");
        return;
      }
      onSessionSelected?.();
      onClose();
    } catch {
      if (!isCurrent()) return;
      setActionError("Couldn't open chat. Try again.");
    } finally {
      if (isCurrent()) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  };

  return (
    <div
      class={`drawer ${open ? "drawer--open" : ""}`}
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is dismiss-only; ESC handled at panel scope */}
      <div class="drawer__backdrop" onClick={requestClose} aria-hidden="true" />
      <aside ref={panelRef} class="drawer__panel" aria-label="Past chats" role="dialog" aria-modal="true" data-history-drawer>
        <header class="drawer__header">
          <h2 class="drawer__heading">Past chats</h2>
          <FoundationIconButton label="Close past chats" variant="quiet" className="drawer__close" disabled={pending} onClick={requestClose} buttonRef={closeRef}>
            <XIcon size={16} />
          </FoundationIconButton>
        </header>
        <SessionSearchBox
          clearSignal={clearSearchSignal ?? undefined}
          onChange={(q) => {
            void sessions.search(q);
          }}
        />
        {showStaleBanner && <StaleBanner checking={sessions.loading.value} onRetry={() => void sessions.load()} />}
        {actionError && <Notice tone="error">{actionError}</Notice>}
        <div class="drawer__list" aria-busy={pending}>
          {showLoadingBlank ? (
            <AsyncState state="loading" title="Loading past chats" />
          ) : showNoResults ? (
            <NoResultsState onClear={clearSearch} />
          ) : visible.length === 0 ? (
            <AsyncState
              state={hasError ? "error" : "empty"}
              title={emptyMessage}
              action={hasError ? <ActionButton variant="quiet" onClick={() => void sessions.load()}>Retry</ActionButton> : undefined}
            />
          ) : (
            <SessionList
              rows={visible}
              currentId={sessions.currentId.value}
              emptyMessage={emptyMessage}
              pending={pending}
              onSwitch={(id, event) => void changeSession(() => sessions.switchTo(id), event.currentTarget as HTMLElement)}
              onAskDelete={(id, title) => setDeleting({ id, title })}
              onAskRename={(id, title) => setRenaming({ id, title })}
            />
          )}
        </div>
        <div class="drawer__footer">
          <NewChatButton
            disabled={pending}
            onClick={(event) => void changeSession(() => sessions.newChat(), event.currentTarget as HTMLElement)}
          />
        </div>
      </aside>
      {renaming && (
        <RenameDialog
          initialTitle={renaming.title}
          onSubmit={(t) => {
            void sessions.rename(renaming.id, t);
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <ConfirmDeleteDialog
          title={deleting.title}
          onConfirm={() => {
            void sessions.delete(deleting.id);
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
