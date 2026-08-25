import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { Dialog } from "../common/dialog.tsx";
import { ActionButton, Field } from "../common/foundation.tsx";

const TITLE_MAX = 200;

export interface RenameDialogProps {
  initialTitle: string;
  onSubmit(title: string): void;
  onClose(): void;
}

export function RenameDialog({
  initialTitle,
  onSubmit,
  onClose,
}: RenameDialogProps): JSX.Element {
  const [draft, setDraft] = useState(initialTitle);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const trimmed = draft.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== initialTitle.trim();

  const submit = (): void => {
    if (!canSubmit) return;
    onSubmit(trimmed.slice(0, TITLE_MAX));
    onClose();
  };

  return (
    <Dialog
      title="Rename chat"
      onClose={onClose}
      initialFocusRef={inputRef as { current: HTMLElement | null }}
      footer={
        <>
          <ActionButton variant="quiet" className="app-dialog__btn app-dialog__btn--ghost" onClick={onClose}>Cancel</ActionButton>
          <ActionButton variant="primary" className="app-dialog__btn app-dialog__btn--primary" disabled={!canSubmit} onClick={submit}>Save</ActionButton>
        </>
      }
    >
      <Field
        id="rename-chat-input"
        inputRef={inputRef}
        className="app-dialog__field"
        inputClassName="app-dialog__input"
        label="Title"
        value={draft}
        maxLength={TITLE_MAX}
        onInput={(event) => setDraft(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
        hint={!canSubmit ? (trimmed.length === 0 ? "Title can't be empty." : "Edit the title to enable Save.") : undefined}
      />
    </Dialog>
  );
}
