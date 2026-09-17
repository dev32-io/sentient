import type { JSX } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { ActionButton } from "./foundation.tsx";
import "./file-picker.css";

export interface FilePickerProps {
  label: string;
  accept?: string | undefined;
  selectedFile?: File | null | undefined;
  error?: string | undefined;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  onSelect: (file: File) => void;
  onRemove: () => void;
}

export function FilePicker({
  label,
  accept,
  selectedFile,
  error,
  disabled = false,
  hint = "Choose a file or drop it here.",
  onSelect,
  onRemove,
}: FilePickerProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const id = useId();
  const errorId = error ? `${id}-error` : undefined;

  useEffect(() => {
    if (!selectedFile && inputRef.current) inputRef.current.value = "";
  }, [selectedFile]);

  const selectFirst = (files: FileList | null): void => {
    if (disabled) return;
    const file = files?.[0];
    if (file) onSelect(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div class="snt-file-picker" data-error={error ? "true" : undefined}>
      <label
        class="snt-file-picker__zone"
        data-dragging={dragging ? "true" : undefined}
        data-disabled={disabled ? "true" : undefined}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          selectFirst(event.dataTransfer?.files ?? null);
        }}
      >
        <span class="snt-file-picker__mark" aria-hidden="true">＋</span>
        <strong>Choose a file</strong>
        <small>{hint}</small>
        <input
          ref={inputRef}
          id={id}
          class="snt-file-picker__input"
          type="file"
          accept={accept}
          aria-label={label}
          aria-describedby={errorId}
          aria-invalid={Boolean(error) || undefined}
          disabled={disabled}
          onChange={(event) => selectFirst(event.currentTarget.files)}
        />
      </label>
      {selectedFile && (
        <div class="snt-file-picker__selection">
          <span class="snt-file-picker__file-icon" aria-hidden="true">F</span>
          <span class="snt-file-picker__file-copy" role="status" aria-live="polite">
            <strong>{selectedFile.name}</strong>
            <small>{selectedFile.size.toLocaleString()} bytes</small>
          </span>
          <ActionButton variant="quiet" disabled={disabled} onClick={onRemove}>Remove</ActionButton>
        </div>
      )}
      {error && <span id={errorId} class="snt-file-picker__error" role="alert">{error}</span>}
    </div>
  );
}
