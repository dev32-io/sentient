// gateway/webui/src/components/voices/VoicesPanel.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ReadonlySignal } from "@preact/signals";
import { createUseVoices } from "../../hooks/use-voices.ts";
import { createUseVoicePreview } from "../../hooks/use-voice-preview.ts";
import { useServiceVersions } from "../../hooks/use-service-versions.ts";
import { useToast } from "../../hooks/use-toast.tsx";
import { createFishApi } from "../../services/fish-api.ts";
import { PaneHead } from "../settings/primitives/pane-head.tsx";
import { Btn } from "../settings/primitives/btn.tsx";
import { Icon } from "../common/icon.tsx";
import { VoiceFilterBar } from "./VoiceFilterBar.tsx";
import { VoicePackGrid } from "./VoicePackGrid.tsx";
import { AddVoiceModal } from "./AddVoiceModal.tsx";
import { deriveTagOptions, filterPacks, type VoiceSource } from "./voice-filter.ts";
import { createVoicesPanelHandlers } from "./voices-panel-handlers.ts";

const fishApi = createFishApi();

export interface VoicesPanelProps {
  token: string;
  /** Seed value — the current profile.voice.id, read fresh on every mount
   *  (settings-view remounts this pane via `key={tab}` on tab switch). */
  activeVoiceId: string;
  /** Sync-only: settings-view mirrors this into profileDraft/profileOriginal
   *  so a later Apply on another tab doesn't revert the voice pick. */
  onActiveVoiceChanged: (voiceId: string) => void;
  /** True while the assistant is mid-TTS playback — gates preview play so a
   *  sample and the live reply never fight over the one audio output. */
  assistantSpeaking?: ReadonlySignal<boolean>;
}

export function VoicesPanel(props: VoicesPanelProps): JSX.Element {
  const { token, activeVoiceId, onActiveVoiceChanged, assistantSpeaking } = props;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [q, setQ] = useState("");
  const [source, setSource] = useState<VoiceSource>("all");
  const [tags, setTags] = useState<string[]>([]);

  // Stable per token identity — onActiveVoiceChanged is a functional-setState
  // sync callback from settings-view (safe to close over the first instance).
  const hook = useMemo(
    () => createUseVoices({ token, initialActiveId: activeVoiceId, onActiveVoiceChanged }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );
  const preview = useMemo(
    () => createUseVoicePreview(token, () => toast.show("Couldn't play preview", "error")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );
  const handlers = useMemo(
    () => createVoicesPanelHandlers({ hook, preview, toast, setBusy, fishApi, token }),
    [hook, preview, toast, token],
  );
  const versions = useServiceVersions(token);
  const fishBrowseEnabled = versions?.features.fish_browse_enabled ?? false;

  useEffect(() => {
    void hook.load();
  }, [hook]);

  // profileOriginal (the source of activeVoiceId) resolves async and can
  // arrive after this pane's first render (or first mutation) — re-sync the
  // hook's local active id whenever the prop settles to its true value.
  // Sync only: never fetches, never PUTs, never calls onActiveVoiceChanged.
  useEffect(() => {
    hook.syncActiveId(activeVoiceId);
  }, [hook, activeVoiceId]);

  // Preview audio must never outlive the pane — tab switch or unmount stops
  // and revokes it, same as an explicit stop().
  useEffect(() => () => preview.stop(), [preview]);

  const all = hook.voices.value ?? [];
  const shown = filterPacks(all, { q, source, tags });
  const allTags = deriveTagOptions(all);
  const previewDisabled = assistantSpeaking?.value ?? false;

  function toggleTag(tag: string): void {
    setTags((cur) => (cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]));
  }

  return (
    <>
      <PaneHead
        title="Voices"
        sub="Record or upload a clip to clone a voice for Sentient's replies."
        action={
          <Btn kind="ghost" size="sm" icon={<Icon name="plus" size={11} />} onClick={() => setAddOpen(true)}>
            Add voice
          </Btn>
        }
      />

      <VoiceFilterBar
        q={q}
        source={source}
        activeTags={tags}
        allTags={allTags}
        onQ={setQ}
        onSource={setSource}
        onToggleTag={toggleTag}
      />

      <VoicePackGrid
        packs={shown}
        loading={hook.loading.value}
        error={hook.error.value}
        activeId={hook.activeId.value}
        previewId={preview.previewId.value}
        previewLoadingId={preview.loadingId.value}
        previewDisabled={previewDisabled}
        busy={busy}
        onPlay={(id) => handlers.handlePlay(id, previewDisabled)}
        onPick={(id) => void handlers.handlePick(id)}
        onDelete={(id) => void handlers.handleDelete(id)}
      />

      <AddVoiceModal
        open={addOpen}
        busy={busy}
        token={token}
        onClose={() => setAddOpen(false)}
        onCreate={handlers.handleCreate}
        fishBrowseEnabled={fishBrowseEnabled}
        onCloneFromFish={handlers.handleCloneFromFish}
      />
    </>
  );
}
