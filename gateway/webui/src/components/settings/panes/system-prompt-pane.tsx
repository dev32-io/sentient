// gateway/webui/src/components/settings/panes/system-prompt-pane.tsx
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import type { ProfileApi, SoulDoc } from "../../../services/profile-api.js";
import { renderMarkdown } from "../../../lib/render-markdown.ts";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Segmented } from "../primitives/segmented.tsx";
import { Textarea } from "../primitives/textarea.tsx";
import { Btn } from "../primitives/btn.tsx";
import { Modal } from "../primitives/modal.tsx";

const log = createLogger(["sentient", "webui", "settings", "system-prompt-pane"]);

export interface SystemPromptPaneProps {
  api: ProfileApi;
  token: string;
  /** Called when user clicks Restore default — replaces draft with template body. */
  onRestoreDefault: (defaultBody: string) => void;
  /** Source of truth for textarea content (controlled by SettingsView). */
  draft: string | null;
  /** Last-saved Soul.md (used for Discard / dirty diff). */
  original: SoulDoc | null;
  /** SettingsView passes a setter so pane can hydrate when fetch lands. */
  setOriginal: (doc: SoulDoc) => void;
  setDraft: (body: string) => void;
}

export function SystemPromptPane({
  api, token, onRestoreDefault,
  draft, original, setOriginal, setDraft,
}: SystemPromptPaneProps): JSX.Element {
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (original !== null) return;
    void (async () => {
      const r = await api.getSoul(token);
      if (!r.ok) {
        log.warn("getSoul.failed", { code: r.error.code });
        setLoadError("Couldn't load Soul.md.");
        return;
      }
      setOriginal(r.value);
      setDraft(r.value.content);
    })();
  }, [api, token, original, setOriginal, setDraft]);

  const handleEdit = (e: Event) => {
    setDraft((e.target as HTMLTextAreaElement).value);
  };

  const handleConfirmRestore = async () => {
    log.debug("restoreDefault.confirmed");
    setRestoring(true);
    const r = await api.getSoulDefault(token);
    setRestoring(false);
    if (!r.ok) {
      log.warn("restoreDefault.failed", { code: r.error.code });
      return;
    }
    onRestoreDefault(r.value.content);
    setConfirmOpen(false);
  };

  const headSub =
    "The base personality and behavior contract loaded into your assistant at boot. " +
    "Edits live in Soul.md and are baked into the next conversation chain after Apply.";

  if (loadError) {
    return (
      <>
        <PaneHead title="System Prompt" sub={headSub} />
        <p class="pane-error">{loadError}</p>
      </>
    );
  }

  if (!original || draft === null) {
    return (
      <>
        <PaneHead title="System Prompt" sub={headSub} />
        <div class="pane-skeleton" aria-hidden="true" />
      </>
    );
  }

  return (
    <>
      <PaneHead title="Persona" sub="The base personality template — Soul.md loaded at boot." />

      <Card
        title="Soul.md"
        sub="Markdown supported. Restart required after Apply."
        action={
          <Btn kind="secondary" size="sm" danger onClick={() => setConfirmOpen(true)}>
            Restore default
          </Btn>
        }
      >
        <div class="md-wrap">
          <Segmented
            value={tab}
            onChange={(v) => setTab(v as "edit" | "preview")}
            options={[
              { value: "edit",    label: "Edit" },
              { value: "preview", label: "Preview" },
            ]}
          />
        </div>
        {tab === "edit" ? (
          <Textarea value={draft} monospace rows={18} onChange={handleEdit} />
        ) : (
          // renderMarkdown sanitizes via DOMPurify before returning HTML.
          <div
            class="md-prev"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }}
          />
        )}
      </Card>

      {confirmOpen && (
        <Modal
          title="Restore default Soul.md?"
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <Btn kind="ghost" size="sm" onClick={() => setConfirmOpen(false)} disabled={restoring}>
                Cancel
              </Btn>
              <Btn kind="primary" size="sm" danger onClick={handleConfirmRestore} disabled={restoring}>
                {restoring ? "Restoring…" : "Restore"}
              </Btn>
            </>
          }
        >
          <p class="modal-lead">
            This replaces your edits with the canonical Soul.md template. Apply &amp; Restart afterwards
            to make it take effect. You can still discard the change before applying.
          </p>
        </Modal>
      )}
    </>
  );
}
