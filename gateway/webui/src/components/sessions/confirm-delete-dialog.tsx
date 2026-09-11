import type { JSX } from "preact";
import { Dialog } from "../common/dialog.tsx";
import { ActionButton } from "../common/foundation.tsx";

export interface ConfirmDeleteDialogProps {
  title: string;
  onConfirm(): void;
  onClose(): void;
}

export function ConfirmDeleteDialog({
  title,
  onConfirm,
  onClose,
}: ConfirmDeleteDialogProps): JSX.Element {
  const truncated = title.length > 60 ? `${title.slice(0, 60)}…` : title;
  return (
    <Dialog
      title="Delete chat?"
      description="This permanently removes the conversation, including its messages. This can't be undone."
      onClose={onClose}
      footer={
        <>
          <ActionButton variant="quiet" className="app-dialog__btn app-dialog__btn--ghost" onClick={onClose}>Cancel</ActionButton>
          <ActionButton variant="destructive" className="app-dialog__btn app-dialog__btn--danger" onClick={() => { onConfirm(); onClose(); }}>Delete</ActionButton>
        </>
      }
    >
      <div class="confirm-delete__target">
        <span class="confirm-delete__target-label">Chat</span>
        <span class="confirm-delete__target-title">{truncated}</span>
      </div>
    </Dialog>
  );
}
