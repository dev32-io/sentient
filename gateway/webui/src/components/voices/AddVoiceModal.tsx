// gateway/webui/src/components/voices/AddVoiceModal.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { Modal } from "../settings/primitives/modal.tsx";
import { Segmented } from "../settings/primitives/segmented.tsx";
import { TextField } from "../settings/primitives/text-field.tsx";
import { Textarea } from "../settings/primitives/textarea.tsx";
import { Btn } from "../settings/primitives/btn.tsx";
import { Icon } from "../common/icon.tsx";
import { VoiceCapture } from "./VoiceCapture.tsx";
import { FishClonePanel, type FishClonePickInput } from "./fish/FishClonePanel.tsx";
import { TagEditor, MAX_TAGS } from "./TagEditor.tsx";

const log = createLogger(["sentient", "webui", "voices", "add-modal"]);

const BASE_MODE_OPTIONS = [
  { value: "record", label: "Record" },
  { value: "upload", label: "Upload" },
];
const FISH_MODE_OPTION = { value: "fish", label: "Clone from Fish Audio" };
const UPLOAD_TYPES = ".wav,.flac,.ogg,.mp3";
const MS_PER_SECOND = 1000;
// The Fish browse grid + toolbar (search + 2 selects) needs materially more
// room than the plain metadata form — widen the modal only in that mode
// (Modal's `width` prop already exists for exactly this).
const RECORD_UPLOAD_MODAL_WIDTH = 440;
const FISH_MODAL_WIDTH = 640;

// Client-side UX hint only — mirrors services.ttsConfig.voice_description_max_len
// (gateway/config.yaml). The gateway re-enforces this cap server-side (see
// parseCreateForm); this just fails fast in the UI. Tag caps live in TagEditor.tsx.
const DESCRIPTION_MAX_LEN = 240;

type CaptureMode = "record" | "upload" | "fish";

export interface AddVoiceModalProps {
  open: boolean;
  /** True while a create op is in flight — disables inputs, keeps the modal open. */
  busy: boolean;
  /** Only read by the Fish browse panel (`fishBrowseEnabled` mode) — the
   *  record/upload paths don't need it. */
  token: string;
  onClose: () => void;
  /** Resolves `true` on a successful create (caller already toasted). The modal
   *  only resets + closes on `true`, so a transient failure leaves the form intact. */
  onCreate: (audio: Blob, name: string, description: string, tags: string[]) => Promise<boolean>;
  /** Gates the third "Clone from Fish Audio" mode. Absent/false hides it entirely. */
  fishBrowseEnabled?: boolean;
  /** Resolves `true` on a successful clone (caller already toasted) — same
   *  contract as `onCreate`, but for a picked Fish voice instead of captured
   *  audio. Only invoked once a Fish voice has been picked. */
  onCloneFromFish: (fishVoiceId: string, name: string, description: string, tags: string[]) => Promise<boolean>;
}

export function AddVoiceModal({
  open,
  busy,
  token,
  onClose,
  onCreate,
  fishBrowseEnabled = false,
  onCloneFromFish,
}: AddVoiceModalProps): JSX.Element | null {
  const [mode, setMode] = useState<CaptureMode>("record");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);
  const [fishVoiceId, setFishVoiceId] = useState<string | null>(null);

  if (!open) return null;

  const modeOptions = fishBrowseEnabled ? [...BASE_MODE_OPTIONS, FISH_MODE_OPTION] : BASE_MODE_OPTIONS;
  const showEditor = mode !== "fish" || fishVoiceId !== null;

  function resetAndClose(): void {
    setMode("record");
    setName("");
    setDescription("");
    setTags([]);
    setAudio(null);
    setAudioDurationMs(null);
    setFishVoiceId(null);
    onClose();
  }

  function handleModeChange(next: string): void {
    setMode(next as CaptureMode);
    // Always re-enter Fish mode at the browse grid, never mid-editor.
    setFishVoiceId(null);
  }

  function handleCaptured(blob: Blob, durationMs: number): void {
    log.debug("audio.captured", { bytes: blob.size, durationMs });
    setAudio(blob);
    setAudioDurationMs(durationMs);
  }

  function handleUpload(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = "";
    if (!file) return;
    log.debug("audio.uploaded", { bytes: file.size, type: file.type });
    setAudio(file);
    setAudioDurationMs(null);
  }

  function handleFishPick({ fishVoiceId: id, suggestedName, suggestedTags }: FishClonePickInput): void {
    log.debug("fish.picked", { fishVoiceIdLength: id.length, suggestedTagCount: suggestedTags.length });
    setFishVoiceId(id);
    setName(suggestedName);
    setTags(suggestedTags.slice(0, MAX_TAGS));
  }

  async function handleSubmit(): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (mode === "fish") {
      if (!fishVoiceId) return;
      log.debug("cloneFromFish.requested", { nameLength: trimmedName.length, tagCount: tags.length });
      const ok = await onCloneFromFish(fishVoiceId, trimmedName, description.trim(), tags);
      if (ok) resetAndClose();
      return;
    }
    if (!audio) return;
    log.debug("create.requested", {
      nameLength: trimmedName.length,
      tagCount: tags.length,
      hasDescription: description.trim().length > 0,
    });
    const ok = await onCreate(audio, trimmedName, description.trim(), tags);
    if (ok) resetAndClose();
  }

  const canSubmit =
    name.trim().length > 0 && !busy && (mode === "fish" ? fishVoiceId !== null : Boolean(audio));

  return (
    <Modal
      title="Add a voice"
      width={mode === "fish" ? FISH_MODAL_WIDTH : RECORD_UPLOAD_MODAL_WIDTH}
      onClose={resetAndClose}
      footer={
        <>
          <Btn kind="ghost" size="sm" onClick={resetAndClose} disabled={busy}>
            Cancel
          </Btn>
          {showEditor && (
            <Btn kind="primary" size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
              {busy ? "Cloning…" : "Clone voice"}
            </Btn>
          )}
        </>
      }
    >
      <div class="voices-add-body">
        <Segmented value={mode} onChange={handleModeChange} options={modeOptions} disabled={busy} />

        {mode === "record" && <VoiceCapture onBlob={handleCaptured} disabled={busy} />}

        {mode === "upload" && (
          <div class="voices-rec">
            <label class="voices-upload-btn">
              <Icon name="plus" size={12} />
              {audio ? "Replace file" : "Choose file"}
              <input type="file" accept={UPLOAD_TYPES} disabled={busy} onChange={handleUpload} />
            </label>
            <span class="voices-rec-hint">WAV, FLAC, OGG, or MP3.</span>
          </div>
        )}

        {mode === "fish" && (
          <>
            <FishClonePanel token={token} busy={busy} onClone={handleFishPick} />
            {fishVoiceId && <p class="voices-rec-hint">Ready to clone — fill in the details below.</p>}
          </>
        )}

        {audio && mode !== "fish" && (
          <p class="voices-rec-hint">
            Clip ready{audioDurationMs !== null ? ` (${(audioDurationMs / MS_PER_SECOND).toFixed(1)}s)` : ""}.
          </p>
        )}

        {showEditor && (
          <>
            <label class="lst-field">
              <span class="lst-field-l">Name</span>
              <TextField
                value={name}
                onChange={(e) => setName((e.target as HTMLInputElement).value)}
                placeholder="e.g. Dad"
                fullWidth
                disabled={busy}
              />
            </label>

            <label class="lst-field">
              <span class="lst-field-l">Description</span>
              <Textarea
                value={description}
                onChange={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
                placeholder="Optional — how this voice sounds or when to use it"
                rows={3}
                maxLength={DESCRIPTION_MAX_LEN}
                disabled={busy}
              />
            </label>

            <TagEditor tags={tags} onChange={setTags} disabled={busy} />
          </>
        )}
      </div>
    </Modal>
  );
}
