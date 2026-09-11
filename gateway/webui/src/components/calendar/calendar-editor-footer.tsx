import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { ActionButton } from "../common/index.ts";
import type { CalendarEditorMode } from "./calendar-editor-types.ts";

export interface CalendarEditorFooterProps {
  readonly mode: CalendarEditorMode;
  readonly formId: string;
  readonly busy: boolean;
  readonly canSave: boolean;
  readonly canDelete: boolean;
  readonly onDelete: () => void;
  readonly onCancel: () => void;
}

/** Mutation actions stay in the editor; this composite only presents them. */
export function CalendarEditorFooter({ mode, formId, busy, canSave, canDelete, onDelete, onCancel }: CalendarEditorFooterProps): JSX.Element {
  const submitRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    submitRef.current?.setAttribute("form", formId);
  }, [formId]);
  return (
    <div class="calendar-editor__footer-layout">
      {mode === "edit" && (
        <ActionButton
          className="app-dialog__btn app-dialog__btn--danger calendar-editor__delete-button"
          disabled={!canDelete}
          onClick={onDelete}
        >
          Delete
        </ActionButton>
      )}
      <span class="calendar-editor__footer-spacer" />
      <ActionButton className="app-dialog__btn app-dialog__btn--ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </ActionButton>
      <ActionButton
        type="submit"
        buttonRef={submitRef}
        className="app-dialog__btn app-dialog__btn--primary"
        disabled={!canSave}
      >
        {busy ? "Saving…" : mode === "create" ? "Add event" : "Save changes"}
      </ActionButton>
    </div>
  );
}
