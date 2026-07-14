// gateway/webui/src/components/voices/AddVoiceModal.tsx
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { createLogger } from "@sentient/web-sdk";
import { Modal } from "../settings/primitives/modal.tsx";
import { Segmented } from "../settings/primitives/segmented.tsx";
import { TextField } from "../settings/primitives/text-field.tsx";
import { Textarea } from "../settings/primitives/textarea.tsx";
import { Btn } from "../settings/primitives/btn.tsx";
import { Chip } from "../settings/primitives/chip.tsx";
import { Icon } from "../common/icon.tsx";
import { VoiceCapture } from "./VoiceCapture.tsx";

const log = createLogger(["sentient", "webui", "voices", "add-modal"]);

const SUGGESTED_TAGS = ["warm", "calm", "deep", "bright", "family", "kids", "news", "soft"];
const MODE_OPTIONS = [
  { value: "record", label: "Record" },
  { value: "upload", label: "Upload" },
];
const UPLOAD_TYPES = ".wav,.flac,.ogg";
const MS_PER_SECOND = 1000;

// Client-side UX hints only — mirror services.ttsConfig.voice_* caps
// (gateway/config.yaml: voice_max_tags, voice_tag_max_len,
// voice_description_max_len). The gateway re-enforces every cap
// server-side (see parseCreateForm); these just fail fast in the UI.
const MAX_TAGS = 8;
const TAG_MAX_LEN = 24;
const DESCRIPTION_MAX_LEN = 240;

type CaptureMode = "record" | "upload";

export interface AddVoiceModalProps {
  open: boolean;
  /** True while a create op is in flight — disables inputs, keeps the modal open. */
  busy: boolean;
  onClose: () => void;
  /** Resolves `true` on a successful create (caller already toasted). The modal
   *  only resets + closes on `true`, so a transient failure leaves the form intact. */
  onCreate: (audio: Blob, name: string, description: string, tags: string[]) => Promise<boolean>;
}

export function AddVoiceModal({ open, busy, onClose, onCreate }: AddVoiceModalProps): JSX.Element | null {
  const [mode, setMode] = useState<CaptureMode>("record");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [audioDurationMs, setAudioDurationMs] = useState<number | null>(null);

  if (!open) return null;

  function resetAndClose(): void {
    setMode("record");
    setName("");
    setDescription("");
    setTags([]);
    setAudio(null);
    setAudioDurationMs(null);
    onClose();
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

  async function handleSubmit(): Promise<void> {
    const trimmedName = name.trim();
    if (!audio || !trimmedName) return;
    log.debug("create.requested", {
      nameLength: trimmedName.length,
      tagCount: tags.length,
      hasDescription: description.trim().length > 0,
    });
    const ok = await onCreate(audio, trimmedName, description.trim(), tags);
    if (ok) resetAndClose();
  }

  const canSubmit = Boolean(audio) && name.trim().length > 0 && !busy;

  return (
    <Modal
      title="Add a voice"
      onClose={resetAndClose}
      footer={
        <>
          <Btn kind="ghost" size="sm" onClick={resetAndClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn kind="primary" size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {busy ? "Cloning…" : "Clone voice"}
          </Btn>
        </>
      }
    >
      <div class="voices-add-body">
        <Segmented value={mode} onChange={(v) => setMode(v as CaptureMode)} options={MODE_OPTIONS} disabled={busy} />

        {mode === "record" ? (
          <VoiceCapture onBlob={handleCaptured} disabled={busy} />
        ) : (
          <div class="voices-rec">
            <label class="voices-upload-btn">
              <Icon name="plus" size={12} />
              {audio ? "Replace file" : "Choose file"}
              <input type="file" accept={UPLOAD_TYPES} disabled={busy} onChange={handleUpload} />
            </label>
            <span class="voices-rec-hint">WAV, FLAC, or OGG.</span>
          </div>
        )}

        {audio && (
          <p class="voices-rec-hint">
            Clip ready{audioDurationMs !== null ? ` (${(audioDurationMs / MS_PER_SECOND).toFixed(1)}s)` : ""}.
          </p>
        )}

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
      </div>
    </Modal>
  );
}

interface TagEditorProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

/** Free-form + suggested tag picker. Private helper co-located per the
 *  webui component rule (one public component per file). */
function TagEditor({ tags, onChange, disabled = false }: TagEditorProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const atCap = tags.length >= MAX_TAGS;
  // Case-insensitive to match addTag's dedup — a shown chip is always actionable.
  const lowerTags = tags.map((t) => t.toLowerCase());
  const suggestions = SUGGESTED_TAGS.filter((t) => !lowerTags.includes(t.toLowerCase()));

  function addTag(raw: string): void {
    const value = raw.trim().slice(0, TAG_MAX_LEN);
    if (!value || atCap) return;
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) return;
    onChange([...tags, value]);
    setDraft("");
  }

  function removeTag(target: string): void {
    onChange(tags.filter((t) => t !== target));
  }

  return (
    <div class="lst-field">
      <span class="lst-field-l">Tags{atCap ? ` (max ${MAX_TAGS})` : ""}</span>

      {tags.length > 0 && (
        <div class="voices-tag-row">
          {tags.map((t) => (
            <Chip key={t} active onClick={() => removeTag(t)} disabled={disabled}>
              {t} ×
            </Chip>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <div class="voices-tag-row">
          {suggestions.map((t) => (
            <Chip key={t} active={false} onClick={() => addTag(t)} disabled={disabled || atCap}>
              {t}
            </Chip>
          ))}
        </div>
      )}

      <form
        class="voices-rec-row"
        onSubmit={(e: Event) => {
          e.preventDefault();
          addTag(draft);
        }}
      >
        <TextField
          value={draft}
          onChange={(e) => setDraft((e.target as HTMLInputElement).value.slice(0, TAG_MAX_LEN))}
          placeholder={atCap ? `Max ${MAX_TAGS} tags` : "Add a tag, press Enter"}
          fullWidth
          disabled={disabled || atCap}
        />
      </form>
    </div>
  );
}
