import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { ActionButton, Field } from "../../common/foundation.tsx";

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
        <ActionButton disabled={disabled || busy} onClick={() => setEditing(true)}>{hasKey ? "Change" : "Add"}</ActionButton>
      </div>
    );
  }

  return (
    <div class="secret-input secret-input--editing">
      <Field
        label={label}
        type="password"
        autoComplete="off"
        value={value}
        placeholder={placeholder ?? (hasKey ? "Replacing existing key" : "Paste your key")}
        disabled={busy || disabled}
        onInput={(event) => setValue(event.currentTarget.value)}
      />
      <ActionButton variant="primary" loading={busy} disabled={!value} onClick={() => void save(value)}>Save</ActionButton>
      <ActionButton variant="quiet" disabled={busy} onClick={() => { setEditing(!hasKey); setValue(""); }}>Cancel</ActionButton>
    </div>
  );
}
