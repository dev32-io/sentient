import { useState } from "preact/hooks";
import type { JSX } from "preact";
import type { LlmProviderStatus } from "../../../services/admin-api.ts";
import { ActionButton, ActionRow, Field, SettingsRow } from "../../common/index.ts";

export type EditingKey = "openrouter" | "ollama-cloud" | "custom" | "custom-baseurl" | null;

export interface RowStatus { has_key: boolean; }
export interface SecretRowProps {
  label: string;
  status: RowStatus;
  isActive?: boolean;
  onSetActive?: (() => void) | undefined;
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: (newKey: string) => Promise<void>;
}

export function SecretRow({ label, status, isActive, onSetActive, editing, onStartEdit, onCancel, onSave }: SecretRowProps): JSX.Element {
  const [draftKey, setDraftKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const cancel = () => { setDraftKey(""); setError(undefined); onCancel(); };
  const save = async () => {
    if (!draftKey.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(draftKey.trim());
      setDraftKey("");
    } catch {
      setError("The key could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRow label={label} hint={status.has_key ? "Configured" : "Not configured"} vertical={editing}>
      {editing ? (
        <div class="owned-secret-edit">
          <Field ariaLabel={`New ${label} key`} type="password" autoComplete="off" value={draftKey} placeholder="Paste new key" disabled={saving} error={error} onInput={(event) => setDraftKey(event.currentTarget.value)} />
          <ActionRow><ActionButton variant="primary" loading={saving} disabled={!draftKey.trim()} onClick={() => void save()}>Save</ActionButton><ActionButton variant="quiet" disabled={saving} onClick={cancel}>Cancel</ActionButton></ActionRow>
        </div>
      ) : (
        <ActionRow>
          {isActive ? <span class="snt-kicker">Active</span> : onSetActive ? <ActionButton variant="quiet" onClick={onSetActive}>Set active</ActionButton> : null}
          <ActionButton variant="quiet" onClick={onStartEdit}>Update</ActionButton>
        </ActionRow>
      )}
    </SettingsRow>
  );
}

interface UrlEditRowProps {
  onCancel: () => void;
  onSave: (url: string) => Promise<void>;
}

function UrlEditRow({ onCancel, onSave }: UrlEditRowProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try { await onSave(draft.trim()); }
    catch { setError("The URL could not be saved. Try again."); }
    finally { setSaving(false); }
  };
  return <div class="owned-secret-edit"><Field ariaLabel="New custom base URL" type="text" autoComplete="off" value={draft} placeholder="https://api.example.com/v1" disabled={saving} error={error} onInput={(event) => setDraft(event.currentTarget.value)} /><ActionRow><ActionButton variant="primary" loading={saving} disabled={!draft.trim()} onClick={() => void save()}>Save</ActionButton><ActionButton variant="quiet" disabled={saving} onClick={onCancel}>Cancel</ActionButton></ActionRow></div>;
}

export interface CustomRowProps {
  status: LlmProviderStatus;
  isActive: boolean;
  onSetActive: () => void;
  editingKey: EditingKey;
  onStartEditKey: () => void;
  onStartEditUrl: () => void;
  onCancel: () => void;
  onSaveKey: (newKey: string) => Promise<void>;
  onSaveUrl: (newUrl: string) => Promise<void>;
}

export function CustomRow(props: CustomRowProps): JSX.Element {
  return (
    <>
      <SecretRow label="Custom" status={{ has_key: props.status.has_key }} isActive={props.isActive} onSetActive={props.onSetActive} editing={props.editingKey === "custom"} onStartEdit={props.onStartEditKey} onCancel={props.onCancel} onSave={props.onSaveKey} />
      <SettingsRow label="Custom base URL" hint={props.status.has_base_url ? "Configured" : "Not configured"} vertical={props.editingKey === "custom-baseurl"}>
        {props.editingKey === "custom-baseurl" ? <UrlEditRow onCancel={props.onCancel} onSave={props.onSaveUrl} /> : <ActionButton variant="quiet" onClick={props.onStartEditUrl}>Update</ActionButton>}
      </SettingsRow>
    </>
  );
}
