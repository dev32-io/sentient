import type { JSX } from "preact";
import type { CalendarMutationScope } from "../../services/calendar-api.ts";
import { ActionButton } from "../common/index.ts";
import { Dialog } from "../common/dialog.tsx";
import { MutationScopeChooser } from "./mutation-scope-chooser.tsx";

export interface DeleteConfirmationProps {
  open?: boolean;
  title: string;
  recurring?: boolean;
  scope?: CalendarMutationScope | undefined;
  busy?: boolean;
  error?: string | null | undefined;
  onScopeChange?(scope: CalendarMutationScope): void;
  onConfirm(scope: CalendarMutationScope): void;
  onCancel(): void;
}

/** Confirmation is deliberately separate from mutation execution. */
export function DeleteConfirmation({
  open = true,
  title,
  recurring = false,
  scope,
  busy = false,
  error,
  onScopeChange,
  onConfirm,
  onCancel,
}: DeleteConfirmationProps): JSX.Element | null {
  if (!open) return null;
  const selectedScope = scope ?? (recurring ? undefined : "entire_series");
  const canConfirm = !busy && selectedScope !== undefined;
  return (
    <Dialog
      title="Delete event?"
      description="This event will be removed from the calendar. This action cannot be undone."
      width={500}
      inertBackground
      onClose={onCancel}
      footer={
        <>
          <ActionButton className="app-dialog__btn app-dialog__btn--ghost" onClick={() => onCancel()} disabled={busy}>
            Cancel
          </ActionButton>
          <ActionButton
            className="app-dialog__btn app-dialog__btn--danger"
            disabled={!canConfirm}
            onClick={() => {
              if (selectedScope) onConfirm(selectedScope);
            }}
          >
            {busy ? "Deleting…" : "Delete event"}
          </ActionButton>
        </>
      }
    >
      <div class="calendar-editor__delete-target">
        <span class="calendar-editor__eyebrow">Event</span>
        <strong>{title}</strong>
      </div>
      {recurring && onScopeChange && (
        <MutationScopeChooser
          value={scope}
          onChange={onScopeChange}
          recurring
          disabled={busy}
          idPrefix="calendar-delete-scope"
        />
      )}
      {recurring && !scope && <p class="calendar-editor__hint">Choose which occurrences to delete.</p>}
      {error && <p class="calendar-editor__error" role="alert">{error}</p>}
    </Dialog>
  );
}
