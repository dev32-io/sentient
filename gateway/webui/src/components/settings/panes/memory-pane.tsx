import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { MEMORY_MD_CHAR_LIMIT, USER_MD_CHAR_LIMIT } from "../../../constants.ts";
import type { MemoryDoc, MemorySlot, ProfileApi, ProfileV1 } from "../../../services/profile-api.js";
import { renderMarkdown } from "../../../lib/render-markdown.ts";
import {
  ActionButton,
  AsyncState,
  PaneChrome,
  SegmentedControl,
  SettingsCard,
  SettingsRow,
  TextArea,
  ToggleControl,
} from "../../common/index.ts";

const log = createLogger(["sentient", "webui", "settings", "memory-pane"]);

const SLOT_LABEL: Record<MemorySlot, string> = { memory: "MEMORY.md", user: "USER.md" };
const SLOT_EXPLAIN: Record<MemorySlot, string> = {
  memory: "Notes about the world, including environment facts, conventions, and things the assistant has learned. The assistant writes and prunes these notes; edit them to seed or correct a fact.",
  user: "Your preferences, communication style, and recurring expectations. The assistant infers these over time; edit them to seed or correct what it remembers about you.",
};
const SLOT_CAP: Record<MemorySlot, number> = { memory: MEMORY_MD_CHAR_LIMIT, user: USER_MD_CHAR_LIMIT };

export interface MemoryPaneProps {
  api: ProfileApi;
  token: string;
  drafts: Record<MemorySlot, string | null>;
  originals: Record<MemorySlot, MemoryDoc | null>;
  setOriginal: (slot: MemorySlot, doc: MemoryDoc) => void;
  setDraft: (slot: MemorySlot, content: string) => void;
  memoryToggles: ProfileV1["memory"];
  onDraftMemoryToggles: (memory: ProfileV1["memory"]) => void;
}

export function MemoryPane({ api, token, drafts, originals, setOriginal, setDraft, memoryToggles, onDraftMemoryToggles }: MemoryPaneProps): JSX.Element {
  const [slot, setSlot] = useState<MemorySlot>("memory");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    if (originals[slot] !== null) return;
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      const result = await api.getMemoryDoc(token, slot);
      if (cancelled) return;
      if (!result.ok) {
        log.warn("getMemoryDoc.failed", { slot, code: result.error.code });
        setLoadError(`Couldn't load ${SLOT_LABEL[slot]}.`);
        return;
      }
      setOriginal(slot, result.value);
      setDraft(slot, result.value.content);
    })();
    return () => { cancelled = true; };
  }, [api, token, slot, originals, setOriginal, setDraft, loadAttempt]);

  const draft = drafts[slot];
  const original = originals[slot];
  const cap = SLOT_CAP[slot];
  const charsUsed = draft?.length ?? original?.content.length ?? 0;

  return (
    <PaneChrome title="Memory" subtitle="Persistent context the assistant carries between conversations. Apply saves changes for the next conversation; a service restart may be needed before every active session sees them.">
      <SettingsCard title="Memory features" subtitle="Changes take effect after Apply.">
        <SettingsRow label="Memory sparking" hint="Bring up relevant past memories in conversation.">
          <ToggleControl label="Memory sparking" checked={memoryToggles.spark} onChange={(spark) => onDraftMemoryToggles({ ...memoryToggles, spark })} />
        </SettingsRow>
        <SettingsRow label="Nightly reflection" hint="Let Sentient reflect on the day and update its notes.">
          <ToggleControl label="Nightly reflection" checked={memoryToggles.dreaming} onChange={(dreaming) => onDraftMemoryToggles({ ...memoryToggles, dreaming })} />
        </SettingsRow>
      </SettingsCard>

      <SegmentedControl
        label="Memory document"
        value={slot}
        onChange={(value) => { setSlot(value as MemorySlot); setView("edit"); }}
        options={[{ value: "memory", label: "General memory" }, { value: "user", label: "About you" }]}
      />

      <SettingsCard
        title={SLOT_LABEL[slot]}
        subtitle={`${SLOT_EXPLAIN[slot]} Limited to ${cap} characters.`}
        action={<span class="memory-count" aria-live="polite">{charsUsed} / {cap}</span>}
      >
        {loadError ? (
          <AsyncState state="error" title={loadError} message="Your unsaved settings were not changed." action={<ActionButton onClick={() => setLoadAttempt((value) => value + 1)}>Retry</ActionButton>} />
        ) : !original || draft === null ? (
          <AsyncState state="loading" title={`Loading ${SLOT_LABEL[slot]}`} />
        ) : (
          <>
            <SegmentedControl label={`${SLOT_LABEL[slot]} view`} value={view} onChange={(value) => setView(value as "edit" | "preview")} options={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
            {view === "edit" ? (
              <TextArea
                label={`Edit ${SLOT_LABEL[slot]}`}
                value={draft}
                monospace
                dirty={draft !== original.content}
                rows={14}
                maxLength={cap}
                onInput={(event) => setDraft(slot, event.currentTarget.value.slice(0, cap))}
                placeholder={`No ${SLOT_LABEL[slot]} yet — the assistant can build it over time, or you can seed it now.`}
              />
            ) : (
              <div class="md-prev" aria-label={`${SLOT_LABEL[slot]} preview`} dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }} />
            )}
          </>
        )}
      </SettingsCard>
    </PaneChrome>
  );
}
