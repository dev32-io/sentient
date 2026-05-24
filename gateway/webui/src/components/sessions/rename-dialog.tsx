import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { Dialog } from "../common/dialog.tsx";

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
          <button
            type="button"
            class="app-dialog__btn app-dialog__btn--ghost"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            class="app-dialog__btn app-dialog__btn--primary"
            disabled={!canSubmit}
            onClick={submit}
          >
            Save
          </button>
        </>
      }
    >
      <div class="app-dialog__field">
        <label class="app-dialog__label" for="rename-chat-input">
          Title
        </label>
        <input
          id="rename-chat-input"
          ref={inputRef}
          class="app-dialog__input"
          type="text"
          value={draft}
          maxLength={TITLE_MAX}
          onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          aria-describedby={canSubmit ? undefined : "rename-chat-hint"}
        />
        {!canSubmit && (
          <span id="rename-chat-hint" class="app-dialog__hint">
            {trimmed.length === 0
              ? "Title can't be empty."
              : "Edit the title to enable Save."}
          </span>
        )}
      </div>
    </Dialog>
  );
}
