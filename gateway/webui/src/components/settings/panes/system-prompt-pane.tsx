import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileApi, SoulDoc } from "../../../services/profile-api.js";
import { renderMarkdown } from "../../../lib/render-markdown.ts";
import { ActionButton, ActionRow, AsyncState, Dialog, Notice, PaneChrome, SegmentedControl, SettingsEditor, TextArea } from "../../common/index.ts";

const log = createLogger(["sentient", "webui", "settings", "system-prompt-pane"]);
const DESCRIPTION = "The base personality and behavior instructions used for new conversations. Changes take effect after Apply.";

export interface SystemPromptPaneProps {
  api: ProfileApi;
  token: string;
  onRestoreDefault: (defaultBody: string) => void;
  draft: string | null;
  original: SoulDoc | null;
  setOriginal: (doc: SoulDoc) => void;
  setDraft: (body: string) => void;
}

export function SystemPromptPane({ api, token, onRestoreDefault, draft, original, setOriginal, setDraft }: SystemPromptPaneProps): JSX.Element {
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    if (original !== null) return;
    setLoadError(null);
    void (async () => {
      const result = await api.getSoul(token);
      if (!result.ok) {
        log.warn("getSoul.failed", { code: result.error.code });
        setLoadError("Couldn't load the system prompt.");
        return;
      }
      setOriginal(result.value);
      setDraft(result.value.content);
    })();
  }, [api, token, original, setOriginal, setDraft, loadAttempt]);

  async function handleConfirmRestore(): Promise<void> {
    setRestoring(true);
    setRestoreError(null);
    const result = await api.getSoulDefault(token);
    setRestoring(false);
    if (!result.ok) {
      log.warn("restoreDefault.failed", { code: result.error.code });
      setRestoreError("Couldn't load the default prompt. Try again.");
      return;
    }
    onRestoreDefault(result.value.content);
    setConfirmOpen(false);
  }

  return (
    <PaneChrome title="System prompt" subtitle={DESCRIPTION}>
      {loadError ? (
        <AsyncState state="error" title={loadError} message="Your unsaved prompt was not changed." action={<ActionButton onClick={() => setLoadAttempt((value) => value + 1)}>Retry</ActionButton>} />
      ) : !original || draft === null ? (
        <AsyncState state="loading" title="Loading system prompt" />
      ) : (
        <SettingsEditor
          title="Persona instructions"
          subtitle="Markdown is supported."
          dirty={draft !== original.content}
          headerAction={<ActionButton variant="destructive" onClick={() => { setRestoreError(null); setConfirmOpen(true); }}>Restore default</ActionButton>}
        >
          <SegmentedControl label="System prompt view" value={tab} onChange={(value) => setTab(value as "edit" | "preview")} options={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
          {tab === "edit" ? <TextArea label="System prompt" value={draft} monospace dirty={draft !== original.content} rows={18} onInput={(event) => setDraft(event.currentTarget.value)} /> : <div class="md-prev" aria-label="System prompt preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }} />}
        </SettingsEditor>
      )}
      {confirmOpen && (
        <Dialog
          title="Restore the default system prompt?"
          description="This replaces your edits with the default template. Apply afterwards to make it take effect; you can still discard the draft before applying."
          closeOnBackdrop={!restoring}
          closeOnEscape={!restoring}
          onClose={() => !restoring && setConfirmOpen(false)}
          footer={<ActionRow><ActionButton variant="quiet" disabled={restoring} onClick={() => setConfirmOpen(false)}>Cancel</ActionButton><ActionButton variant="destructive" loading={restoring} onClick={() => void handleConfirmRestore()}>Restore</ActionButton></ActionRow>}
        >
          {restoreError && <Notice tone="error">{restoreError}</Notice>}
        </Dialog>
      )}
    </PaneChrome>
  );
}
