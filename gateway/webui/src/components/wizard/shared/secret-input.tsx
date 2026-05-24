import { useState } from "preact/hooks";
import type { JSX } from "preact";

const MASK = "••••••••••••";

export interface SecretInputProps {
  hasKey: boolean;
  onSave: (value: string | null) => Promise<void>;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
}

export function SecretInput({
  hasKey,
  onSave,
  placeholder,
  label,
  disabled,
}: SecretInputProps): JSX.Element {
  const [editing, setEditing] = useState(!hasKey);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(next: string | null) {
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
      setValue("");
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div class="secret-input secret-input--idle">
        {label && <label>{label}</label>}
        <span class="secret-input__masked">{hasKey ? MASK : "Not set"}</span>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => setEditing(true)}
        >
          {hasKey ? "Change" : "Add"}
        </button>
      </div>
    );
  }

  return (
    <div class="secret-input secret-input--editing">
      {label && <label>{label}</label>}
      <input
        type="password"
        autoComplete="off"
        value={value}
        placeholder={
          placeholder ?? (hasKey ? "Replacing existing key" : "Paste your key")
        }
        disabled={busy || disabled}
        onInput={(e) => setValue((e.target as HTMLInputElement).value)}
      />
      <button type="button" disabled={busy || !value} onClick={() => save(value)}>
        Save
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setEditing(hasKey ? false : true);
          setValue("");
        }}
      >
        Cancel
      </button>
    </div>
  );
}
