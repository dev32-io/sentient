// gateway/webui/src/components/settings/panes/memory-pane.tsx
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { MEMORY_MD_CHAR_LIMIT, USER_MD_CHAR_LIMIT } from "../../../constants.ts";
import type { MemoryDoc, MemorySlot, ProfileApi } from "../../../services/profile-api.js";
import { renderMarkdown } from "../../../lib/render-markdown.ts";
import { Card } from "../primitives/card.tsx";
import { PaneHead } from "../primitives/pane-head.tsx";
import { Segmented } from "../primitives/segmented.tsx";
import { Textarea } from "../primitives/textarea.tsx";

const log = createLogger(["sentient", "webui", "settings", "memory-pane"]);

const SLOT_LABEL: Record<MemorySlot, string> = {
  memory: "MEMORY.md",
  user: "USER.md",
};

const SLOT_EXPLAIN: Record<MemorySlot, string> = {
  memory:
    "Hermes-managed notes about the world: environment facts, conventions, " +
    "things the agent has learned. The agent autonomously writes and prunes " +
    "this. Hand-edit when you want to seed or correct a fact.",
  user:
    "Your user profile: preferences, communication style, recurring " +
    "expectations. The agent infers this over time across conversations. " +
    "Edit to seed or correct what the assistant believes about you.",
};

const SLOT_CAP: Record<MemorySlot, number> = {
  memory: MEMORY_MD_CHAR_LIMIT,
  user: USER_MD_CHAR_LIMIT,
};

export interface MemoryPaneProps {
  api: ProfileApi;
  token: string;
  drafts: Record<MemorySlot, string | null>;
  originals: Record<MemorySlot, MemoryDoc | null>;
  setOriginal: (slot: MemorySlot, doc: MemoryDoc) => void;
  setDraft: (slot: MemorySlot, content: string) => void;
}

export function MemoryPane({
  api, token, drafts, originals, setOriginal, setDraft,
}: MemoryPaneProps): JSX.Element {
  const [slot, setSlot] = useState<MemorySlot>("memory");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [loadError, setLoadError] = useState<string | null>(null);

  // Lazy-load each slot when it's first viewed.
  useEffect(() => {
    if (originals[slot] !== null) return;
    let cancelled = false;
    (async () => {
      const r = await api.getMemoryDoc(token, slot);
      if (cancelled) return;
      if (!r.ok) {
        log.warn("getMemoryDoc.failed", { slot, code: r.error.code });
        setLoadError(`Couldn't load ${SLOT_LABEL[slot]}.`);
        return;
      }
      setOriginal(slot, r.value);
      setDraft(slot, r.value.content);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, token, slot, originals, setOriginal, setDraft]);

  const draft = drafts[slot];
  const original = originals[slot];
  const cap = SLOT_CAP[slot];

  const handleEdit = (e: Event) => {
    const v = (e.target as HTMLTextAreaElement).value;
    // Browser maxLength clamps physically, but defensive trim on paste edge cases.
    setDraft(slot, v.length > cap ? v.slice(0, cap) : v);
  };

  const headSub =
    "Persistent context Hermes carries between conversations. The agent " +
    "writes and prunes this autonomously; you can hand-edit. Apply saves " +
    "your changes so the next chain reads the new content.";

  if (loadError) {
    return (
      <>
        <PaneHead title="Memory" sub={headSub} />
        <p class="pane-error">{loadError}</p>
      </>
    );
  }

  const charsUsed = draft?.length ?? original?.content.length ?? 0;
  const overCap = charsUsed > cap;

  return (
    <>
      <PaneHead title="Memory" sub={headSub} />

      <div class="md-wrap">
        <Segmented
          value={slot}
          onChange={(v) => {
            log.debug("memory.slot.change", { slot: v });
            setSlot(v as MemorySlot);
            setView("edit");
          }}
          options={[
            { value: "memory", label: "MEMORY.md" },
            { value: "user",   label: "USER.md"   },
          ]}
        />
      </div>

      <Card
        title={SLOT_LABEL[slot]}
        sub={`${SLOT_EXPLAIN[slot]} Hard-capped at ${cap} characters per Hermes spec. Applies immediately.`}
        action={
          <span class={`memory-count${overCap ? " over" : ""}`}>
            {charsUsed} / {cap}
          </span>
        }
      >
        <div class="md-wrap">
          <Segmented
            value={view}
            onChange={(v) => setView(v as "edit" | "preview")}
            options={[
              { value: "edit",    label: "Edit" },
              { value: "preview", label: "Preview" },
            ]}
          />
        </div>
        {!original || draft === null ? (
          <div class="pane-skeleton" aria-hidden="true" />
        ) : view === "edit" ? (
          <Textarea
            value={draft}
            monospace
            rows={14}
            maxLength={cap}
            onChange={handleEdit}
            placeholder={`No ${SLOT_LABEL[slot]} yet — Hermes will write here over time, or seed it now.`}
          />
        ) : (
          // renderMarkdown sanitizes via DOMPurify before returning HTML.
          <div
            class="md-prev"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }}
          />
        )}
      </Card>
    </>
  );
}
