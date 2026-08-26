import type { JSX } from "preact";
import { ActionButton } from "../common/index.ts";
import { Dialog } from "../common/dialog.tsx";

export interface CalendarDiscardChangesDialogProps {
  readonly open?: boolean;
  readonly onKeepEditing: () => void;
  readonly onDiscard: () => void;
}

/** Sheet/dialog policy is kept out of the draft state machine. */
export function CalendarDiscardChangesDialog({ open = true, onKeepEditing, onDiscard }: CalendarDiscardChangesDialogProps): JSX.Element | null {
  if (!open) return null;
  return (
    <Dialog
      title="Discard changes?"
      description="Your unsaved calendar draft will be lost."
      width={460}
      inertBackground
      onClose={onKeepEditing}
      footer={
        <>
          <ActionButton className="app-dialog__btn app-dialog__btn--ghost" onClick={onKeepEditing}>
            Keep editing
          </ActionButton>
          <ActionButton className="app-dialog__btn app-dialog__btn--danger" onClick={onDiscard}>
            Discard draft
          </ActionButton>
        </>
      }
    />
  );
}
