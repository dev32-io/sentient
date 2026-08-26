import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { useSessionsContext } from "../../context/sessions.tsx";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog.tsx";
import { NewChatButton } from "./new-chat-button.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { SessionList } from "./session-list.tsx";
import { SessionSearchBox } from "./session-search-box.tsx";
import { ActionButton, FoundationIconButton } from "../common/foundation.tsx";
import { AsyncState, Notice } from "../common/composites.tsx";
import { XIcon } from "../common/icons/x.tsx";

const EMPTY_DEFAULT = "No past chats yet.";
const EMPTY_LOAD_FAIL = "Couldn't load sessions — try again.";

interface PendingTarget {
  id: string;
  title: string;
}

export interface DrawerProps {
  open: boolean;
  onClose(): void;
}

export function Drawer({ open, onClose }: DrawerProps): JSX.Element {
  const sessions = useSessionsContext();
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<PendingTarget | null>(null);
  const [deleting, setDeleting] = useState<PendingTarget | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

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
        onClose();
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
  const emptyMessage = hasError
    ? EMPTY_LOAD_FAIL
    : searchActive
      ? `No matches for "${query.trim()}"`
      : EMPTY_DEFAULT;
  const showLoadingBlank = sessions.loading.value && sessions.items.value.length === 0;
  const showStaleErrorBanner = hasError && visible.length > 0;

  return (
    <div class={`drawer ${open ? "drawer--open" : ""}`} aria-hidden={!open}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is dismiss-only; ESC handled at panel scope */}
      <div class="drawer__backdrop" onClick={onClose} aria-hidden="true" />
      <aside ref={panelRef} class="drawer__panel" aria-label="Past chats" role="dialog" aria-modal="true" data-history-drawer>
        <header class="drawer__header">
          <h2 class="drawer__heading">Past chats</h2>
          <FoundationIconButton label="Close past chats" variant="quiet" className="drawer__close" onClick={onClose} buttonRef={closeRef}>
            <XIcon size={16} />
          </FoundationIconButton>
        </header>
        <SessionSearchBox
          onQueryInput={(q) => setQuery(q)}
          onChange={(q) => {
            void sessions.search(q);
          }}
        />
        {showStaleErrorBanner && (
          <Notice tone="error" title="History may be out of date">
            <ActionButton variant="quiet" className="drawer__error-retry" onClick={() => void sessions.load()}>Retry</ActionButton>
          </Notice>
        )}
        <div class="drawer__list">
          {showLoadingBlank ? (
            <AsyncState state="loading" title="Loading past chats" />
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
              onSwitch={async (id) => {
                await sessions.switchTo(id);
                onClose();
              }}
              onAskDelete={(id, title) => setDeleting({ id, title })}
              onAskRename={(id, title) => setRenaming({ id, title })}
            />
          )}
        </div>
        <div class="drawer__footer">
          <NewChatButton
            onClick={() => {
              // Fire-and-forget: sessions.newChat() sends session.new over WS
              // (intent: "explicit") and resolves once the gateway answers
              // session.draft — no session row yet, just a draft key the
              // composer's next send will mint against. The gateway's
              // sendDraftHandshake sends an empty conversation.snapshot on
              // the SAME socket just before session.draft, which is what
              // actually clears the chat pane (ConversationHistoryConnector's
              // ordinary snapshot handling, not a session-boundary special
              // case — see use-voice-client.ts's onSessionsChanged for the
              // verified-redundant belt-and-suspenders clear alongside it).
              // Awaiting the promise here would only re-block the drawer's
              // close on that round trip; the user can type immediately.
              void sessions.newChat();
              onClose();
            }}
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
