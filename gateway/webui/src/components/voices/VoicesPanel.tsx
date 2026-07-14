// gateway/webui/src/components/voices/VoicesPanel.tsx
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { createUseVoices } from "../../hooks/use-voices.ts";
import { useToast } from "../../hooks/use-toast.tsx";
import { Card } from "../settings/primitives/card.tsx";
import { PaneHead } from "../settings/primitives/pane-head.tsx";
import { Icon } from "../common/icon.tsx";
import { VoiceRecorder } from "./VoiceRecorder.tsx";
import { VoiceList } from "./VoiceList.tsx";

const log = createLogger(["sentient", "webui", "voices", "panel"]);
const ACCEPTED_UPLOAD_TYPES = ".wav,.flac,.ogg";

export interface VoicesPanelProps {
  token: string;
  /** Seed value — the current profile.voice.id, read fresh on every mount
   *  (settings-view remounts this pane via `key={tab}` on tab switch). */
  activeVoiceId: string;
  /** Sync-only: settings-view mirrors this into profileDraft/profileOriginal
   *  so a later Apply on another tab doesn't revert the voice pick. */
  onActiveVoiceChanged: (voiceId: string) => void;
}

export function VoicesPanel({ token, activeVoiceId, onActiveVoiceChanged }: VoicesPanelProps): JSX.Element {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // Stable per token identity — onActiveVoiceChanged is a functional-setState
  // sync callback from settings-view (safe to close over the first instance).
  const hook = useMemo(
    () => createUseVoices({ token, initialActiveId: activeVoiceId, onActiveVoiceChanged }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

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

  async function handleCreate(audio: Blob, name: string): Promise<boolean> {
    log.debug("create.requested", { audioBytes: audio.size, nameLength: name.length });
    setBusy(true);
    // TODO(Task 11-12): stopgap args — description/tags UI lands in the
    // VoicesPanel rewrite; this panel doesn't collect them yet.
    const r = await hook.createVoice(audio, name, "", []);
    setBusy(false);
    if (!r.ok) {
      toast.show("Couldn't create voice", "error");
      return false;
    }
    toast.show(
      r.warning === "not-activated" ? "Voice saved, but activation failed — try selecting it below." : "Voice created",
      r.warning ? "error" : "success",
    );
    // A `warning` still means the pack exists server-side — success.
    return true;
  }

  async function handleDelete(voiceId: string): Promise<void> {
    log.debug("delete.requested", { voiceId });
    setBusy(true);
    const r = await hook.deleteVoice(voiceId);
    setBusy(false);
    if (!r.ok) {
      toast.show("Couldn't delete voice", "error");
      return;
    }
    toast.show(
      r.warning === "profile-not-updated" ? "Voice deleted, but the active pick may be stale." : "Voice deleted",
      r.warning ? "error" : "success",
    );
  }

  async function handleSetActive(voiceId: string): Promise<void> {
    log.debug("setActive.requested", { voiceId });
    setBusy(true);
    const r = await hook.setActiveVoice(voiceId);
    setBusy(false);
    if (!r.ok) toast.show("Couldn't switch voice", "error");
  }

  async function handleUpload(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (!file) return;
    const name = file.name.replace(/\.[^.]+$/, "") || "My voice";
    await handleCreate(file, name);
  }

  return (
    <>
      <PaneHead title="Voices" sub="Record or upload a clip to clone a voice for Sentient's replies." />

      <Card title="Add a voice">
        <VoiceRecorder onCreate={handleCreate} busy={busy} />
        <div class="voices-upload">
          <span class="voices-upload-hint">Or upload a WAV / FLAC / OGG clip:</span>
          <label class="voices-upload-btn">
            <Icon name="plus" size={12} />
            Upload
            <input type="file" accept={ACCEPTED_UPLOAD_TYPES} disabled={busy} onChange={(e) => void handleUpload(e)} />
          </label>
        </div>
      </Card>

      <Card title="Your voices" padding={false}>
        <VoiceList
          voices={hook.voices.value}
          loading={hook.loading.value}
          error={hook.error.value}
          activeId={hook.activeId.value}
          busy={busy}
          onSetActive={(id) => void handleSetActive(id)}
          onDelete={(id) => void handleDelete(id)}
        />
      </Card>
    </>
  );
}
