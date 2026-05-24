// gateway/webui/src/components/settings/panes/secret-row.tsx
import { useState } from "preact/hooks";
import type { JSX } from "preact";
import { createLogger } from "@sentient/web-sdk";
import type { LlmProviderStatus } from "../../../services/admin-api.ts";
import { Btn } from "../primitives/btn.tsx";

const log = createLogger(["sentient", "webui", "settings", "secrets"]);

const GENERIC_KEY_PLACEHOLDER = "••••••••••••";

// --- Shared types ------------------------------------------------------------

export type EditingKey = "openrouter" | "ollama-cloud" | "custom" | "custom-baseurl" | "fish-audio" | null;

export interface RowStatus {
  has_key: boolean;
}

export interface SecretRowProps {
  label: string;
  providerKey: string;
  status: RowStatus;
  statusHint?: string | undefined;
  isActive?: boolean | undefined;
  onSetActive?: (() => void) | undefined;
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSave: (newKey: string) => Promise<void>;
}

// --- SecretRow ---------------------------------------------------------------

export function SecretRow({
  label,
  providerKey,
  status,
  statusHint,
  isActive,
  onSetActive,
  editing,
  onStartEdit,
  onCancel,
  onSave,
}: SecretRowProps): JSX.Element {
  const [draftKey, setDraftKey] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!draftKey.trim()) return;
    setSaving(true);
    log.debug("secrets.row.save", { provider: providerKey, hasKey: draftKey.length > 0 });
    try {
      await onSave(draftKey.trim());
      setDraftKey("");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setDraftKey("");
    onCancel();
  }

  const dot = (
    <span
      class={`s-dot ${status.has_key ? "s-dot--ok" : "s-dot--off"}`}
      title={status.has_key ? "Configured" : "Not configured"}
    />
  );

  const activeBadge = isActive ? <span class="tag tag-active">active</span> : null;
  const setActiveLink =
    !isActive && onSetActive ? (
      <button type="button" class="s-set-active" onClick={onSetActive}>
        Set active
      </button>
    ) : null;

  return (
    <div class={`s-secret-row ${editing ? "s-secret-row--editing" : ""}`}>
      <div class="s-secret-row__head">
        <div class="s-secret-row__label">
          {dot}
          <span class="s-secret-row__name">{label}</span>
          {activeBadge}
          {setActiveLink}
        </div>
        <div class="s-secret-row__actions">
          {editing ? (
            <>
              <Btn kind="primary" size="sm" disabled={saving || !draftKey.trim()} onClick={handleSave}>
                Save
              </Btn>
              <Btn kind="ghost" size="sm" disabled={saving} onClick={handleCancel}>
                Cancel
              </Btn>
            </>
          ) : (
            <Btn kind="ghost" size="sm" onClick={onStartEdit}>
              Update
            </Btn>
          )}
        </div>
      </div>

      {editing ? (
        <div class="s-secret-row__edit">
          <input
            type="password"
            class="s-secret-row__input"
            placeholder="Paste new key…"
            value={draftKey}
            onInput={(e) => setDraftKey((e.target as HTMLInputElement).value)}
            disabled={saving}
            autoFocus
          />
        </div>
      ) : (
        <div class="s-secret-row__masked">
          {status.has_key ? (
            <>
              <code>{GENERIC_KEY_PLACEHOLDER}</code>
              {statusHint && <span class="s-secret-row__hint"> · {statusHint}</span>}
            </>
          ) : (
            <span class="s-secret-row__unset">Not configured</span>
          )}
        </div>
      )}
    </div>
  );
}

// --- UrlEditRow --------------------------------------------------------------

interface UrlEditRowProps {
  current: string | null;
  onCancel: () => void;
  onSave: (url: string) => Promise<void>;
}

function UrlEditRow({ current, onCancel, onSave }: UrlEditRowProps): JSX.Element {
  const [draft, setDraft] = useState(current ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(draft.trim());
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <input
        type="url"
        class="s-secret-row__input"
        placeholder="https://api.example.com/v1"
        value={draft}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        disabled={saving}
        autoFocus
      />
      <div class="s-secret-row__edit-acts">
        <Btn kind="primary" size="sm" disabled={saving || !draft.trim()} onClick={handleSave}>
          Save
        </Btn>
        <Btn kind="ghost" size="sm" disabled={saving} onClick={onCancel}>
          Cancel
        </Btn>
      </div>
    </>
  );
}

// --- CustomRow (key + base_url) ----------------------------------------------

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

export function CustomRow({
  status,
  isActive,
  onSetActive,
  editingKey,
  onStartEditKey,
  onStartEditUrl,
  onCancel,
  onSaveKey,
  onSaveUrl,
}: CustomRowProps): JSX.Element {
  return (
    <>
      <SecretRow
        label="Custom"
        providerKey="custom"
        status={{ has_key: status.has_key }}
        statusHint={status.has_base_url ? GENERIC_KEY_PLACEHOLDER : undefined}
        isActive={isActive}
        onSetActive={onSetActive}
        editing={editingKey === "custom"}
        onStartEdit={onStartEditKey}
        onCancel={onCancel}
        onSave={onSaveKey}
      />
      <div class="s-secret-row s-secret-row--subrow">
        <div class="s-secret-row__head">
          <div class="s-secret-row__label">
            <span class="s-secret-row__name s-secret-row__name--sub">Base URL</span>
          </div>
          <div class="s-secret-row__actions">
            {editingKey !== "custom-baseurl" && (
              <Btn kind="ghost" size="sm" onClick={onStartEditUrl}>
                Update
              </Btn>
            )}
          </div>
        </div>
        {editingKey === "custom-baseurl" ? (
          <div class="s-secret-row__edit">
            <UrlEditRow current={null} onCancel={onCancel} onSave={onSaveUrl} />
          </div>
        ) : (
          <div class="s-secret-row__masked">
            {status.has_base_url ? (
              <code>{GENERIC_KEY_PLACEHOLDER}</code>
            ) : (
              <span class="s-secret-row__unset">Not set</span>
            )}
          </div>
        )}
      </div>
    </>
  );
}
