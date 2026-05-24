import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useSessionsContext } from "../../context/sessions.tsx";
import { ConfirmDeleteDialog } from "./confirm-delete-dialog.tsx";
import { NewChatButton } from "./new-chat-button.tsx";
import { RenameDialog } from "./rename-dialog.tsx";
import { SessionList } from "./session-list.tsx";
import { SessionSearchBox } from "./session-search-box.tsx";

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

  // Lazy-load on first open. Subsequent opens still re-fetch so the list
  // reflects new chats from other tabs / since-last-view.
  useEffect(() => {
    if (open) void sessions.load();
  }, [open, sessions]);

  // Escape closes the drawer — but only when no dialog is open. Dialog and
  // row-menu register capture-phase ESC handlers that stopPropagation, so
  // this bubble-phase listener never fires while one of them is up. The
  // dialog-state guard below is belt-and-suspenders for the dialog case.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (renaming || deleting) return;
      onClose();
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
      <div class="drawer__backdrop" onClick={onClose} />
      <aside class="drawer__panel" aria-label="Past chats">
        <header class="drawer__header">
          <h2 class="drawer__heading">Past chats</h2>
        </header>
        <SessionSearchBox
          onQueryInput={(q) => setQuery(q)}
          onChange={(q) => {
            void sessions.search(q);
          }}
        />
        {showStaleErrorBanner && (
          <div class="drawer__error" role="status" aria-live="polite">
            <span>Sync failed — list may be stale.</span>
            <button
              type="button"
              class="drawer__error-retry"
              onClick={() => {
                void sessions.load();
              }}
            >
              Retry
            </button>
          </div>
        )}
        <div class="drawer__list">
          {showLoadingBlank ? (
            <div
              class="session-list session-list--empty"
              role="status"
              aria-live="polite"
            >
              Loading…
            </div>
          ) : visible.length === 0 ? (
            <div
              class="session-list session-list--empty"
              role="status"
              aria-live="polite"
            >
              {emptyMessage}
              {hasError && (
                <button
                  type="button"
                  class="drawer__error-retry drawer__error-retry--inline"
                  onClick={() => {
                    void sessions.load();
                  }}
                >
                  Retry
                </button>
              )}
            </div>
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
              // Fire-and-forget: gateway clears the chat pane synchronously
              // (switchFlow.switchTo("")) and kicks ACP `session/new` in the
              // background. The user can type into the empty input
              // immediately; onCycle awaits the stashed Promise before
              // dispatching the first prompt. Awaiting here would re-block
              // the drawer close on the cold-start latency we're trying to
              // hide.
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
